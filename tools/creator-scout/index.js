import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";
import defaults from "./config.js";
import { exactReferenceMatch, referenceTitles } from "./reference-match.js";

const toolName = "creator-scout";

async function getArisaPackageDir() {
  if (process.env.ARISA_PACKAGE_DIR) return process.env.ARISA_PACKAGE_DIR;
  return (await readFile(path.join(os.homedir(), ".arisa", "arisa-package-dir"), "utf8")).trim();
}

async function importArisa(relativePath) {
  return import(pathToFileURL(path.join(await getArisaPackageDir(), "src", relativePath)).href);
}

const { loadToolConfig } = await importArisa("core/tools/tool-config.js");
const { createArisaClient } = await importArisa("core/tools/ipc-client.js");
const { toolError, toolOk } = await importArisa("core/tools/tool-result.js");
const { getChatToolStateDir } = await importArisa("runtime/paths.js");

function printHelp() {
  console.log(`creator-scout

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions via args.action:
  authenticate  Request and consume a CreatorScout magic link through Gmail.
  status        Report whether the persistent profile is signed in.
  search        Search by comparable game or genre. args: query, language?, recency?, revealEmails?, maxEmailLookups?, limit?, requireExactReference?, referenceTitles?.

When requireExactReference=true, referenceTitles must list the exact comparable title and any localized aliases. Unrelated result rows are removed before email lookup. Search output still requires provenance and campaign deduplication review.
`);
}

function asBoolean(value, fallback = false) {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

async function openContext(chatId, config) {
  const profileDir = path.join(getChatToolStateDir(String(chatId), toolName), "browser-profile");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  return chromium.launchPersistentContext(profileDir, {
    headless: asBoolean(config.HEADLESS, true),
    viewport: { width: 1440, height: 1000 }
  });
}

async function signedIn(page) {
  await page.goto("https://www.creatorscout.dev/saved", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);
  return (await page.locator("body").innerText()).includes("Sign out");
}

function magicLink(text) {
  return String(text || "").match(/https:\/\/rzvtlfacuzfxpvtdxqyz\.supabase\.co\/auth\/v1\/verify\?[^\]\s)]+/)?.[0] || "";
}

async function freshMagicLink(arisa, startedAt) {
  const after = Math.floor((startedAt - 60000) / 1000);
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const listed = await arisa.tools.run({
      name: "gmail-workspace",
      args: { action: "search", q: `from:auth@creatorscout.dev subject:"Your CreatorScout Sign-In Link" after:${after}`, maxResults: "10" }
    }, { timeoutMs: 60000 });
    if (listed.ok) {
      for (const item of listed.output?.json?.messages || []) {
        const fetched = await arisa.tools.run({ name: "gmail-workspace", args: { action: "get", id: item.id, format: "full" } }, { timeoutMs: 60000 });
        const link = fetched.ok ? magicLink(fetched.output?.text) : "";
        if (link) return { link, messageId: item.id };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("CreatorScout magic-link email did not arrive in time");
}

async function authenticate(request, config) {
  const context = await openContext(request.chatId, config);
  try {
    const page = context.pages()[0] || await context.newPage();
    if (await signedIn(page)) return { authenticated: true, reused: true };
    const startedAt = Date.now();
    await page.goto("https://www.creatorscout.dev/login", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.locator('input[type="email"]').fill(config.EMAIL);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    const arisa = createArisaClient({ toolName, chatId: request.chatId });
    const { link, messageId } = await freshMagicLink(arisa, startedAt);
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    if (!(await signedIn(page))) throw new Error("CreatorScout did not retain the authenticated session");
    await arisa.tools.run({ name: "gmail-workspace", args: { action: "mark-read", id: messageId } }, { timeoutMs: 30000 }).catch(() => {});
    return { authenticated: true, reused: false };
  } finally {
    await context.close();
  }
}

function valueAfter(text, label) {
  return String(text).match(new RegExp(`${label}\\s*\\n?([^\\n]+)`, "i"))?.[1]?.trim() || null;
}

function emailFrom(text) {
  return String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || null;
}

async function resultRows(page) {
  const links = page.locator('a[aria-label="Open channel"]');
  const rows = [];
  for (let index = 0; index < await links.count(); index += 1) {
    const row = links.nth(index).locator('xpath=ancestor::div[contains(@class,"md:flex-row")][1]');
    if (await row.count()) rows.push(row);
  }
  return rows;
}

async function parseRow(row) {
  const text = await row.innerText();
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const channel = row.locator('a[aria-label="Open channel"]');
  const references = row.locator('a[href*="youtube.com/watch"],a[href*="twitch.tv/videos"]');
  return {
    name: lines[0] || null,
    handle: lines.find((line) => line.startsWith("@")) || null,
    platform: lines.find((line) => ["YOUTUBE", "TWITCH"].includes(line.toUpperCase()))?.toLowerCase() || null,
    channelUrl: await channel.getAttribute("href"),
    referenceTitle: await references.count() ? (await references.first().innerText()).replace(/^[“"]|[”"]$/g, "") : null,
    referenceUrl: await references.count() ? await references.first().getAttribute("href") : null,
    subscribers: valueAfter(text, "SUBS"),
    averageViews: valueAfter(text, "AVG VIEWS"),
    match: valueAfter(text, "MATCH"),
    email: emailFrom(text),
    rawText: text
  };
}

async function revealEmail(page, row) {
  const trigger = row.getByText(/find email/i);
  if (!(await trigger.count())) return { email: emailFrom(await row.innerText()), lookup: "unavailable" };
  await trigger.first().click();
  await page.waitForTimeout(2500);
  const dialog = page.locator('[role="dialog"]');
  const text = `${await row.innerText()}\n${await dialog.count() ? await dialog.last().innerText() : ""}`;
  return { email: emailFrom(text), lookup: emailFrom(text) ? "found" : "not-found", detail: text.slice(0, 1200) };
}

async function search(request, config) {
  const query = String(request.args?.query || request.text || "").trim();
  if (!query) throw new Error("args.query is required");
  const context = await openContext(request.chatId, config);
  try {
    const page = context.pages()[0] || await context.newPage();
    if (!(await signedIn(page))) throw new Error("CreatorScout authentication is required. Run action=authenticate.");
    await page.goto("https://www.creatorscout.dev/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.locator('input[placeholder*="Paste your Steam link"]').fill(query);
    const language = String(request.args?.language || "").toLowerCase();
    if (language) await page.locator("select").selectOption(language).catch(() => {});
    const recency = String(request.args?.recency || "90d");
    await page.getByRole("button", { name: recency, exact: true }).click().catch(() => {});
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes("creators matching"), null, { timeout: 60000 });
    await page.waitForTimeout(1200);

    const rows = await resultRows(page);
    const limit = Math.min(rows.length, boundedInteger(request.args?.limit, config.MAX_RESULTS || 20, 1, 100));
    const reveal = asBoolean(request.args?.revealEmails, false);
    const maxLookups = reveal ? boundedInteger(request.args?.maxEmailLookups, config.MAX_EMAIL_LOOKUPS || 3, 0, 20) : 0;
    const strictReference = asBoolean(request.args?.requireExactReference, false);
    const expectedTitles = referenceTitles(request.args);
    if (strictReference && !expectedTitles.length) throw new Error("referenceTitles is required when requireExactReference=true");
    const results = [];
    let lookups = 0;
    let filteredOut = 0;
    for (let index = 0; index < rows.length && results.length < limit; index += 1) {
      const result = await parseRow(rows[index]);
      result.referenceMatch = exactReferenceMatch(result.referenceTitle, expectedTitles);
      if (strictReference && !result.referenceMatch.exact) {
        filteredOut += 1;
        continue;
      }
      if (lookups < maxLookups) {
        Object.assign(result, await revealEmail(page, rows[index]));
        lookups += 1;
      }
      delete result.rawText;
      results.push(result);
    }
    return { query, total: rows.length, strictReference, expectedTitles, filteredOut, emailLookups: lookups, results };
  } finally {
    await context.close();
  }
}

async function handle(request) {
  const config = await loadToolConfig(toolName, defaults, request.chatId);
  const action = String(request.args?.action || "status");
  if (action === "authenticate") return authenticate(request, config);
  if (action === "search") return search(request, config);
  if (action === "status") {
    const context = await openContext(request.chatId, config);
    try {
      const page = context.pages()[0] || await context.newPage();
      return { authenticated: await signedIn(page) };
    } finally {
      await context.close();
    }
  }
  throw new Error(`Unsupported action: ${action}`);
}

async function main() {
  const [, , command, flag, requestFile] = process.argv;
  if (process.argv.includes("--help") || !command) return printHelp();
  if (command !== "run" || flag !== "--request-file" || !requestFile) return console.log(JSON.stringify(toolError("Invalid usage. Run node index.js --help.")));
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    const output = await handle(request);
    console.log(JSON.stringify(toolOk({ text: JSON.stringify(output, null, 2), json: output, mimeType: "application/json" })));
  } catch (error) {
    console.log(JSON.stringify(toolError(error?.message || String(error))));
  }
}

main();
