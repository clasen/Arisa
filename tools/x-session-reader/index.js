import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import defaults from "./config.js";

const toolName = "x-session-reader";
const importCore = (relativePath) => import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, "src", relativePath)).href);
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { toolError, toolNeedsConfig, toolOk } = await importCore("core/tools/tool-result.js");
const { getChatToolConfigPath, getChatToolStateDir, getToolConfigPath, getToolStateDir, getChatToolTmpDir, getToolTmpDir } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`x-session-reader

Usage:
  node index.js --help
  node index.js run --request-file <json>

Reads posts visible to a user-provided X/Twitter web session. It uses your own cookies in a normal Playwright browser session. It does not solve CAPTCHAs, bypass login, rotate fingerprints, or evade anti-bot systems.

Expected input:
  {
    "text": "martinclasen" | "https://x.com/martinclasen",
    "args": {
      "action": "profile" | "bookmarks",
      "username": "martinclasen",
      "maxResults": "25, or 250 default with export=true",
      "includeReplies": "false",
      "raw": "false",
      "export": "false",
      "format": "json" | "markdown" | "csv",
      "maxScrolls": "80",
      "idleLimit": "12",
      "scrollDelayMs": "900"
    }
  }

Config:
  X_COOKIES  JSON cookie array exported from your browser, or a raw Cookie header.
  CHROME_EXECUTABLE_PATH optional Chrome/Chromium executable path for Playwright.
  HEADLESS true|false.

Notes:
  - export=true returns a document artifact instead of inline text.
  - Bookmark exports can scroll deep history, save incrementally, and stop after idleLimit scrolls with no new posts.
`);
}

function usernameFrom(input = "", args = {}) {
  const direct = String(args.username || "").trim();
  if (direct) return direct.replace(/^@/, "");
  const text = String(input || "").trim();
  const urlMatch = text.match(/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i);
  if (urlMatch) return urlMatch[1];
  const handleMatch = text.match(/@?([A-Za-z0-9_]{1,15})/);
  return handleMatch ? handleMatch[1] : "";
}

function boolArg(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !/^(false|0|no)$/i.test(String(value));
}

function intArg(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeCookie(cookie) {
  const normalized = {
    name: String(cookie.name || ""),
    value: String(cookie.value || ""),
    domain: cookie.domain || ".x.com",
    path: cookie.path || "/",
    secure: cookie.secure !== false,
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: ["Strict", "Lax", "None"].includes(cookie.sameSite) ? cookie.sameSite : undefined
  };
  const expires = cookie.expires ?? cookie.expirationDate;
  if (Number.isFinite(Number(expires)) && Number(expires) > 0) normalized.expires = Number(expires);
  return normalized;
}

function cookiesFromHeader(header) {
  return String(header)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index < 1) return null;
      return normalizeCookie({ name: part.slice(0, index), value: part.slice(index + 1) });
    })
    .filter(Boolean);
}

function cookiesFromNetscape(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length < 7) return null;
      const [domain, , cookiePath, secure, expires, name, ...valueParts] = parts;
      return normalizeCookie({
        domain,
        path: cookiePath || "/",
        secure: /^true$/i.test(secure),
        expires: Number(expires),
        name,
        value: valueParts.join("\t")
      });
    })
    .filter((cookie) => cookie?.name && cookie.value);
}

function parseCookies(rawCookies) {
  const raw = String(rawCookies || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cookies) ? parsed.cookies : [];
    return list.map(normalizeCookie).filter((cookie) => cookie.name && cookie.value);
  } catch {
    if (raw.includes("\t") && /Netscape HTTP Cookie File|^\.?[\w.-]+\t/m.test(raw)) return cookiesFromNetscape(raw);
    return cookiesFromHeader(raw);
  }
}

function postUrlFromArticle(article) {
  const links = [...article.querySelectorAll('a[href*="/status/"]')].map((link) => link.href);
  return links.find((href) => /\/status\/\d+/.test(href)) || "";
}

async function extractPosts(page, maxResults, includeReplies) {
  return page.evaluate(({ maxResults, includeReplies }) => {
    const postUrlFromArticle = (article) => {
      const links = [...article.querySelectorAll('a[href*="/status/"]')].map((link) => link.href);
      return links.find((href) => /\/status\/\d+/.test(href)) || "";
    };
    const items = [];
    const seen = new Set();
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const textNodes = [...article.querySelectorAll('[data-testid="tweetText"]')].map((node) => node.innerText.trim()).filter(Boolean);
      const text = textNodes.join("\n").trim();
      const url = postUrlFromArticle(article);
      const time = article.querySelector("time")?.getAttribute("datetime") || "";
      const author = article.querySelector('[data-testid="User-Name"]')?.innerText?.trim() || "";
      const isReply = /Replying to/i.test(article.innerText);
      if (!includeReplies && isReply) continue;
      if (!text || seen.has(url || text)) continue;
      seen.add(url || text);
      items.push({ author, text, url, time });
      if (items.length >= maxResults) break;
    }
    return items;
  }, { maxResults, includeReplies });
}

async function collectVisiblePosts(page, options) {
  const { maxResults, includeReplies, maxScrolls, idleLimit, scrollDelayMs, onProgress } = options;
  const posts = [];
  const seen = new Set();
  let idle = 0;
  let lastHeight = 0;
  for (let attempt = 0; attempt < maxScrolls && posts.length < maxResults && idle < idleLimit; attempt += 1) {
    const visible = await extractPosts(page, maxResults, includeReplies);
    let added = 0;
    for (const post of visible) {
      const key = post.url || post.text;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      posts.push(post);
      added += 1;
      if (posts.length >= maxResults) break;
    }
    const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
    if (added === 0 && height === lastHeight) idle += 1;
    else idle = 0;
    lastHeight = height;
    if (onProgress) await onProgress({ posts, attempt, added, idle });
    if (posts.length >= maxResults || idle >= idleLimit) break;
    await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 1.2))).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, scrollDelayMs));
  }
  return posts;
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function formatCsv(posts) {
  return [
    "index,author,time,url,text",
    ...posts.map((post, index) => [index + 1, post.author, post.time, post.url, post.text].map(csvEscape).join(","))
  ].join("\n");
}

function formatMarkdown(title, posts) {
  return [
    `# ${title}`,
    "",
    `Exported: ${new Date().toISOString()}`,
    `Count: ${posts.length}`,
    "",
    ...posts.map((post, index) => [
      `## ${index + 1}. ${post.author?.split("\n")[0] || "Unknown author"}`,
      "",
      `- URL: ${post.url || ""}`,
      `- Time: ${post.time || ""}`,
      "",
      post.text || "",
      ""
    ].join("\n"))
  ].join("\n");
}

function exportBody(format, action, username, posts) {
  if (format === "csv") return { body: formatCsv(posts), mimeType: "text/csv", extension: "csv" };
  if (format === "markdown" || format === "md") {
    const title = action === "bookmarks" ? "X/Twitter bookmarks export" : `X/Twitter @${username} posts export`;
    return { body: formatMarkdown(title, posts), mimeType: "text/markdown", extension: "md" };
  }
  return {
    body: JSON.stringify({ action, username: action === "bookmarks" ? null : username, exportedAt: new Date().toISOString(), count: posts.length, posts }, null, 2),
    mimeType: "application/json",
    extension: "json"
  };
}

async function writeExportFile({ request, action, username, posts, format }) {
  const tmpDir = request.chatId != null ? getChatToolTmpDir(request.chatId, toolName) : getToolTmpDir(toolName);
  await mkdir(tmpDir, { recursive: true });
  const { body, mimeType, extension } = exportBody(format, action, username, posts);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = action === "bookmarks" ? "x-bookmarks" : `x-${username || "profile"}-posts`;
  const fileName = `${base}-${stamp}.${extension}`;
  const filePath = path.join(tmpDir, fileName);
  await writeFile(filePath, body, "utf8");
  return { filePath, fileName, mimeType };
}

function formatPosts(title, posts, emptyMessage) {
  if (!posts.length) return emptyMessage;
  return [
    title,
    "",
    ...posts.map((post, index) => [
      `${index + 1}. ${post.time || "unknown time"}${post.author ? ` — ${post.author}` : ""}`,
      post.text,
      post.url ? `   ${post.url}` : null
    ].filter(Boolean).join("\n"))
  ].join("\n\n");
}

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const config = await loadToolConfig(toolName, defaults, request.chatId ?? null);

  if (!config.X_COOKIES) {
    console.log(JSON.stringify(toolNeedsConfig({
      tool: toolName,
      missingConfig: ["X_COOKIES"],
      configPath: request.chatId != null ? getChatToolConfigPath(request.chatId, toolName) : getToolConfigPath(toolName),
      message: "Paste your X/Twitter cookies as a JSON array exported from your browser, or as a raw Cookie header."
    })));
    return;
  }

  const cookies = parseCookies(config.X_COOKIES);
  if (!cookies.length) {
    console.log(JSON.stringify(toolError("Could not parse X_COOKIES. Use a JSON cookie array or raw Cookie header.")));
    return;
  }

  const args = request.args || {};
  const action = String(args.action || (/\/i\/bookmarks/i.test(request.text || "") ? "bookmarks" : "profile")).toLowerCase();
  const username = usernameFrom(args.username || request.text || request.artifact?.text || "", args);
  if (action !== "bookmarks" && !username) {
    console.log(JSON.stringify(toolError("username, text handle, X profile URL, or args.action=bookmarks is required")));
    return;
  }

  const wantsExport = boolArg(args.export ?? args.download, false);
  const maxCap = wantsExport ? 1000 : 100;
  const maxResults = Math.min(Math.max(intArg(args.maxResults, wantsExport ? 250 : 3), 1), maxCap);
  const includeReplies = boolArg(args.includeReplies, false);
  const maxScrolls = Math.min(Math.max(intArg(args.maxScrolls, wantsExport ? 150 : 8), 1), 500);
  const idleLimit = Math.min(Math.max(intArg(args.idleLimit, wantsExport ? 12 : 8), 1), 50);
  const scrollDelayMs = Math.min(Math.max(intArg(args.scrollDelayMs, wantsExport ? 900 : 1200), 100), 10000);
  const format = String(args.format || "json").toLowerCase();
  const stateDir = request.chatId != null ? getChatToolStateDir(request.chatId, toolName) : getToolStateDir(toolName);
  const userDataDir = path.join(stateDir, `browser-profile-${Date.now()}`);
  await mkdir(userDataDir, { recursive: true });

  let browser = null;
  try {
    browser = await chromium.launchPersistentContext(userDataDir, {
      headless: boolArg(config.HEADLESS, true),
      executablePath: config.CHROME_EXECUTABLE_PATH || undefined,
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    await browser.route("**/*", async (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) return route.abort().catch(() => {});
      return route.continue().catch(() => {});
    });
    await browser.addCookies(cookies);
    const page = await browser.newPage();
    const targetUrl = action === "bookmarks" ? "https://x.com/i/bookmarks" : `https://x.com/${encodeURIComponent(username)}`;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector('article[data-testid="tweet"], [data-testid="emptyState"], input[name="text"], [data-testid="loginButton"]', { timeout: 30000 }).catch(() => {});
    const loginVisible = await page.locator('input[name="text"], [data-testid="loginButton"]').count().catch(() => 0);
    if (loginVisible > 0) {
      console.log(JSON.stringify(toolError("X session is not logged in or requires verification. Refresh X_COOKIES from your browser and try again.")));
      return;
    }
    let latestExport = null;
    const posts = await collectVisiblePosts(page, {
      maxResults,
      includeReplies,
      maxScrolls,
      idleLimit,
      scrollDelayMs,
      onProgress: wantsExport ? async ({ posts, attempt, added }) => {
        if (added > 0 || attempt % 5 === 0) latestExport = await writeExportFile({ request, action, username, posts, format });
      } : null
    });

    if (wantsExport) {
      latestExport = await writeExportFile({ request, action, username, posts, format });
      console.log(JSON.stringify(toolOk({
        text: `Exported ${posts.length} ${action === "bookmarks" ? "bookmark" : "post"}${posts.length === 1 ? "" : "s"}.`,
        filePath: latestExport.filePath,
        fileName: latestExport.fileName,
        kind: "document",
        mimeType: latestExport.mimeType,
        metadata: { action, count: posts.length, maxResults, maxScrolls, idleLimit },
        delivery: { method: "document" }
      })));
    } else if (boolArg(args.raw, false)) {
      console.log(JSON.stringify(toolOk({ text: JSON.stringify({ action, username: action === "bookmarks" ? null : username, posts }, null, 2), mimeType: "application/json" })));
    } else if (action === "bookmarks") {
      console.log(JSON.stringify(toolOk({ text: formatPosts("Latest visible X/Twitter bookmarks:", posts, "No bookmarks were visible. The session may be logged out, blocked by X verification, or there may be no visible bookmarks.") })));
    } else {
      console.log(JSON.stringify(toolOk({ text: formatPosts(`@${username} latest visible post${posts.length === 1 ? "" : "s"}:`, posts, `No posts were visible for @${username}. The session may be logged out, blocked by X verification, or the account may have no visible posts.`) })));
    }
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args[0] === "help") {
  printHelp();
} else if (args[0] === "run") {
  const fileIndex = args.indexOf("--request-file");
  await run(args[fileIndex + 1]);
} else {
  printHelp();
}
