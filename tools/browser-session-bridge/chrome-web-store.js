import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

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

function validateDashboardUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.hostname !== "chrome.google.com" || !url.pathname.startsWith("/webstore/devconsole/")) {
    throw new Error("A Chrome Web Store Developer Dashboard URL is required");
  }
  return url;
}

async function validateZip(filePath) {
  if (path.extname(filePath).toLowerCase() !== ".zip") throw new Error("Chrome Web Store package must be a ZIP file");
  const details = await stat(filePath);
  if (!details.isFile() || details.size < 1 || details.size > 2_000_000_000) throw new Error("Invalid Chrome Web Store package size");
}

async function authenticatedContext(stateDir, resourceId, browser) {
  if (resourceId !== "chrome.google.com") throw new Error("The chrome.google.com browser session is required");
  const sessionPath = path.join(stateDir, "sessions", `${resourceId}.json`);
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  if (!Array.isArray(session.cookies) || !session.cookies.length) throw new Error("Stored Chrome Web Store session has no cookies");
  const context = await browser.newContext();
  await context.addCookies(session.cookies.map(toPlaywrightCookie));
  return context;
}

async function selectPackage(page, zipPath) {
  const input = page.locator('input[type="file"]');
  if (await input.count()) {
    await input.first().setInputFiles(zipPath);
    return;
  }
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 5000 });
  const browse = page.getByText(/browse files|choose file|select file/i).first();
  await browse.click();
  const chooser = await chooserPromise;
  await chooser.setFiles(zipPath);
}

function itemIdentifier(url) {
  const match = url.pathname.match(/\/items\/([a-z]{32})(?:\/|$)/i);
  return match?.[1] || null;
}

export async function uploadChromeWebStoreDraft({ stateDir, resourceId = "chrome.google.com", dashboardUrl, zipPath }) {
  const url = validateDashboardUrl(dashboardUrl);
  await validateZip(zipPath);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await authenticatedContext(stateDir, resourceId, browser);
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    if (!/Chrome Web Store Developer Dashboard/i.test(await page.title())) throw new Error("Chrome Web Store session is not authenticated");
    if (!/There are no items yet|New item/i.test(await page.locator("body").innerText())) throw new Error("Could not verify the publisher item list");

    await page.getByText("New item", { exact: true }).last().click();
    await page.waitForTimeout(700);
    await selectPackage(page, zipPath);
    await page.waitForTimeout(5000);

    const body = (await page.locator("body").innerText()).trim();
    const itemId = itemIdentifier(new URL(page.url()));
    const accepted = Boolean(itemId) || /store listing|package|privacy practices|distribution/i.test(body);
    if (!accepted) {
      const visibleError = body.match(/(?:error|failed|invalid)[^\n]{0,300}/i)?.[0];
      throw Object.assign(new Error(visibleError || "Package upload result is uncertain; inspect the dashboard before retrying"), { uncertain: true });
    }
    return {
      uploaded: true,
      submittedForReview: false,
      itemId,
      url: page.url(),
      title: await page.title(),
      visibleText: body.slice(0, 12000)
    };
  } finally {
    await browser.close();
  }
}
