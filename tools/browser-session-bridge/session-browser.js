import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { refreshSessionOnBrowserClose } from "./session-store.js";

function assertResourceId(value) {
  const resourceId = String(value || "").toLowerCase();
  if (!/^(?=.{1,253}$)[a-z0-9.-]+$/.test(resourceId) || resourceId.includes("..")) throw new Error("A valid resourceId hostname is required");
  return resourceId;
}

function assertAllowedUrl(value, resourceId) {
  const url = new URL(String(value || ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only plain HTTP(S) URLs are supported");
  const hostname = url.hostname.toLowerCase();
  if (hostname !== resourceId && !hostname.endsWith(`.${resourceId}`) && !resourceId.endsWith(`.${hostname}`)) {
    throw new Error("URL hostname is outside the stored session scope");
  }
  return url;
}

function playwrightSameSite(value) {
  if (value === "strict") return "Strict";
  if (value === "lax") return "Lax";
  if (value === "no_restriction") return "None";
  return undefined;
}

function toPlaywrightCookie(cookie) {
  const converted = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly)
  };
  const sameSite = playwrightSameSite(cookie.sameSite);
  if (sameSite) converted.sameSite = sameSite;
  if (Number.isFinite(cookie.expirationDate)) converted.expires = cookie.expirationDate;
  return converted;
}

export async function openWithSession({ stateDir, resourceId: rawResourceId, url: rawUrl, maxChars = 30000 }) {
  const resourceId = assertResourceId(rawResourceId);
  const url = assertAllowedUrl(rawUrl, resourceId);
  const sessionPath = path.join(stateDir, "sessions", `${resourceId}.json`);
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  if (!Array.isArray(session.cookies) || !session.cookies.length) throw new Error("Stored session has no cookies");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    if (session.cookies.length) await context.addCookies(session.cookies.map(toPlaywrightCookie));
    if (session.webStorage) {
      await context.addInitScript(({ origin, webStorage }) => {
        if (location.origin !== origin) return;
        for (const [key, value] of Object.entries(webStorage.local || {})) localStorage.setItem(key, value);
        for (const [key, value] of Object.entries(webStorage.session || {})) sessionStorage.setItem(key, value);
      }, { origin: new URL(session.sourceUrl).origin, webStorage: session.webStorage });
    }
    refreshSessionOnBrowserClose({ browser, context, stateDir, session });
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    const text = (await page.locator("body").innerText()).trim().slice(0, Math.min(100000, Math.max(1000, maxChars)));
    return { resourceId, url: page.url(), title: await page.title(), text };
  } finally {
    await browser.close();
  }
}
