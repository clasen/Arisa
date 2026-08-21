import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import defaults from "./config.js";
import { cacheBudgetBytes, chromiumCacheArgs, pruneChromiumCaches } from "./browser-cache.js";

const toolName = "x-dm";
const bridgeToolName = "browser-session-bridge";
const fallbackCookieToolName = "x-session-reader";
const stateVersion = 3;
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || process.env.ARISA_INSTALL_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { toolError, toolNeedsConfig, toolOk } = await importCore("core/tools/tool-result.js");
const { getChatToolConfigPath, getChatToolStateDir, getToolConfigPath, getToolStateDir } = await importCore("runtime/paths.js");

let activeBrowser = null;
let outputWritten = false;

function emitFatal(error) {
  if (!outputWritten) {
    process.stdout.write(`${JSON.stringify(toolError(error?.message || String(error)))}\n`);
    outputWritten = true;
  }
}

process.on("unhandledRejection", (error) => { emitFatal(error); process.exit(1); });
process.on("uncaughtException", (error) => { emitFatal(error); process.exit(1); });

function printHelp() {
  console.log(`x-dm

Usage:
  node index.js --help
  node index.js run --request-file <json>

Safely checks X profiles, manages the logged-in profile, publishes explicitly confirmed posts, and sends one explicitly approved DM at a time. It does not bypass login, CAPTCHAs, DM restrictions, or platform limits.

Actions:
  audit    Read campaign/send health without opening X. args: campaignId?
  status   Check the X session and include campaign/send health. args: campaignId?
  check    Validate a target profile and whether its DM button is visible. args: username
  search   Search visible X posts or people without sending. args: query, mode=posts|people, maxResults?
  verify-delivery Read a bound target conversation and reconcile one unresolved uncertain attempt. args: attemptId, username, message or messageHash
  resolve-uncertain Record human confirmation of one uncertain attempt without opening X. args: attemptId, username, message or messageHash, outcome=delivered|not-sent, confirm=true
  get-bio  Read the logged-in account bio without changing it.
  get-posts Read recent visible posts from the logged-in account. args: maxResults?
  get-thread Read one exact visible X post and its loaded replies. args: postUrl, maxResults?
  update-bio Replace or append to the logged-in account bio. args: bio? or appendText?, confirm=true
  create-post Publish one exact post from the logged-in account through the X web composer. args: post, confirm=true
  reply-post Reply once to an exact visible X post. args: postUrl, reply, targetText? (search fallback), campaignId?, confirm=true, dryRun=false
  relationship-status Read the target-bound Follow/Following state without changing it. args: username
  follow   Follow one target profile and record campaign metadata. args: username, campaignId?, unfollowIfNoResponse?, confirm=true
  unfollow Unfollow only a profile previously followed by this tool. Requires noResponseConfirmed=true and confirm=true.
  send     Send one approved DM. args: username, message, campaignId?, confirm=true, dryRun=false

Safety and reliability:
  - send requires confirm=true and dryRun=false
  - one send runs at a time through a chat-scoped lock
  - duplicate recipients, cooldown, and daily cap are enforced
  - follow changes require explicit confirmation, exact target binding, state verification, and a daily cap
  - unfollow is allowed only for a tool-created follow after explicit no-response confirmation
  - target conversation must remain stable before the tool types or clicks send
  - success requires immediate send evidence or an exact-message readback after reopening the bound conversation
  - explicit send-button confirmation is required; keyboard fallback is never used
  - uncertain delivery is recorded and blocks an automatic retry
  - every browser run has a hard timeout and uses a persistent chat-scoped browser profile
  - state writes are atomic and campaign-scoped metadata is retained

Config:
  X_COOKIES                X/Twitter session cookies. Prefers browser-session-bridge x.com sessions, then this value, then x-session-reader cookies.
  X_CHAT_PASSCODE          Optional secret passcode for encrypted X Chat history.
  CHROME_EXECUTABLE_PATH   Optional Chrome/Chromium executable.
  HEADLESS                 true|false.
  EXPECTED_ACCOUNT_HANDLE  Optional sending-account guard.
  MIN_SECONDS_BETWEEN_SENDS
  MAX_SENDS_PER_DAY
  MAX_SENDS_PER_CAMPAIGN_PER_DAY
  MIN_SECONDS_BETWEEN_FOLLOWS
  MAX_FOLLOWS_PER_DAY
  OPERATION_TIMEOUT_MS
`);
}

function boolArg(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !/^(false|0|no)$/i.test(String(value));
}

function exactBoolean(value, expected) {
  if (typeof value === "boolean") return value === expected;
  return String(value || "").trim().toLowerCase() === String(expected);
}

function intArg(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanHandle(value) {
  const handle = String(value || "").trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : "";
}

function usernameFrom(input = "", args = {}) {
  const direct = cleanHandle(args.username);
  if (direct) return direct;
  const text = String(input || "").trim();
  const urlMatch = text.match(/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/i);
  if (urlMatch) return cleanHandle(urlMatch[1]);
  const handleMatch = text.match(/@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/);
  return handleMatch ? cleanHandle(handleMatch[1]) : "";
}

function campaignIdFrom(args = {}) {
  return String(args.campaignId || "default").trim().replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "default";
}

function messageFrom(request, args) {
  return String(args.message || request.text || request.artifact?.text || "").replace(/\r\n/g, "\n").trim();
}

function messageHash(message) {
  return crypto.createHash("sha256").update(message, "utf8").digest("hex").slice(0, 16);
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
  return String(header).split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 1 ? null : normalizeCookie({ name: part.slice(0, index), value: part.slice(index + 1) });
  }).filter(Boolean);
}

function cookiesFromNetscape(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
    const parts = line.split("\t");
    if (parts.length < 7) return null;
    const [domain, , cookiePath, secure, expires, name, ...valueParts] = parts;
    return normalizeCookie({ domain, path: cookiePath || "/", secure: /^true$/i.test(secure), expires: Number(expires), name, value: valueParts.join("\t") });
  }).filter((cookie) => cookie?.name && cookie.value && (/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(cookie.domain.replace(/^\./, "")) || cookie.domain.includes("x.com")));
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

async function loadBridgeCookies(chatId) {
  if (chatId == null || chatId === "") return "";
  const stateDir = getChatToolStateDir(chatId, bridgeToolName);
  const sessionPath = path.join(stateDir, "sessions", "x.com.json");
  try {
    const session = JSON.parse((await readFile(sessionPath, "utf8")).replace(/^\uFEFF/, ""));
    return Array.isArray(session.cookies) && session.cookies.length ? JSON.stringify(session.cookies) : "";
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw new Error(`Could not read ${bridgeToolName} x.com session: ${error.message || error}`);
  }
}

async function loadConfig(request) {
  const config = await loadToolConfig(toolName, defaults, request.chatId ?? null);
  const bridgeCookies = await loadBridgeCookies(request.chatId ?? null);
  if (bridgeCookies) return { ...config, X_COOKIES: bridgeCookies };
  if (config.X_COOKIES) return config;
  const fallback = await loadToolConfig(fallbackCookieToolName, { X_COOKIES: "" }, request.chatId ?? null);
  return { ...config, X_COOKIES: fallback.X_COOKIES || "" };
}

function normalizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  const sends = Array.isArray(source.sends) ? source.sends : [];
  const derivedRecipients = Object.fromEntries(sends.map((entry) => [String(entry.username || "").toLowerCase(), {
    username: entry.username,
    firstSentAt: entry.sentAt,
    lastSentAt: entry.sentAt,
    campaignId: sentCampaignId(entry)
  }]).filter(([handle]) => handle));
  return {
    version: stateVersion,
    sends,
    posts: Array.isArray(source.posts) ? source.posts : [],
    replies: Array.isArray(source.replies) ? source.replies : [],
    follows: source.follows && typeof source.follows === "object" && !Array.isArray(source.follows) ? source.follows : {},
    attempts: Array.isArray(source.attempts) ? source.attempts : [],
    recipientIndex: { ...derivedRecipients, ...(source.recipientIndex || {}) }
  };
}

async function readState(statePath) {
  try {
    return normalizeState(JSON.parse((await readFile(statePath, "utf8")).replace(/^\uFEFF/, "")));
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeState({});
    throw new Error(`X DM state is unreadable; refusing to bypass safeguards: ${error.message || error}`);
  }
}

async function writeState(statePath, state) {
  const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `﻿${JSON.stringify(normalizeState(state), null, 2)}\n`, "utf8");
  await rename(temporary, statePath);
}

async function acquireStateLock(stateDir, lockName = "operation.lock") {
  const lockPath = path.join(stateDir, lockName);
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > 5 * 60 * 1000) await rm(lockPath, { force: true });
  } catch {}
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    return async () => {
      await handle.close().catch(() => {});
      await rm(lockPath, { force: true }).catch(() => {});
    };
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Another X DM operation is already running for this chat.");
    throw error;
  }
}

function appendAttempt(state, attempt) {
  const record = { at: new Date().toISOString(), attemptId: attempt.attemptId || crypto.randomUUID(), ...attempt };
  state.attempts = [...state.attempts, record].slice(-2000);
  return record;
}

function sentCampaignId(entry) {
  return String(entry.campaignId || "legacy");
}

function auditState(state, campaignId = "") {
  const filtered = campaignId ? state.sends.filter((entry) => sentCampaignId(entry) === campaignId) : state.sends;
  const handles = filtered.map((entry) => String(entry.username || "").toLowerCase()).filter(Boolean);
  const duplicateRecipients = [...new Set(handles.filter((handle, index) => handles.indexOf(handle) !== index))];
  const byDay = {};
  const byCampaign = {};
  for (const entry of filtered) {
    const day = String(entry.sentAt || "unknown").slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    const id = sentCampaignId(entry);
    byCampaign[id] = (byCampaign[id] || 0) + 1;
  }
  const resolvedAttemptIds = new Set(state.attempts.filter((attempt) => ["sent", "failed", "not-sent"].includes(attempt.outcome)).map((attempt) => attempt.attemptId));
  const uncertain = state.attempts.filter((attempt) => attempt.outcome === "uncertain" && !resolvedAttemptIds.has(attempt.attemptId) && (!campaignId || attempt.campaignId === campaignId));
  const unresolved = state.attempts.filter((attempt) => attempt.outcome === "in-flight" && !resolvedAttemptIds.has(attempt.attemptId) && (!campaignId || attempt.campaignId === campaignId));
  return {
    stateVersion: state.version,
    campaignId: campaignId || null,
    sent: filtered.length,
    uniqueRecipients: new Set(handles).size,
    recipients: [...new Set(filtered.map((entry) => String(entry.username || "")).filter(Boolean))],
    duplicateRecipients,
    byDay,
    byCampaign,
    lastSend: filtered.at(-1) || null,
    uncertainDeliveries: uncertain.slice(-20),
    unresolvedAttempts: unresolved.slice(-20),
    recipientIndexSize: Object.keys(state.recipientIndex || {}).length,
    follows: Object.values(state.follows || {}).filter((entry) => !campaignId || entry.campaignId === campaignId),
    recentAttempts: state.attempts.filter((attempt) => !campaignId || attempt.campaignId === campaignId).slice(-20)
  };
}

function withinDailyCap(state, campaignId, globalMax, campaignMax) {
  const today = new Date().toISOString().slice(0, 10);
  const todayEntries = state.sends.filter((entry) => String(entry.sentAt || "").startsWith(today));
  const globalCount = todayEntries.length;
  const campaignCount = todayEntries.filter((entry) => sentCampaignId(entry) === campaignId).length;
  return {
    allowed: globalCount < globalMax && campaignCount < campaignMax,
    globalCount, globalMax, campaignCount, campaignMax
  };
}

function duplicateGuard(state, username, idempotencyKey) {
  const normalized = username.toLowerCase();
  const indexed = state.recipientIndex?.[normalized];
  if (indexed) return `@${username} is already present in the X DM recipient index (${indexed.campaignId || "unknown campaign"}).`;
  const sent = state.sends.find((entry) => String(entry.username || "").toLowerCase() === normalized || entry.idempotencyKey === idempotencyKey);
  if (sent) return `@${username} is already present in the X DM send log (${sentCampaignId(sent)}).`;
  const matchingSends = state.attempts.filter((attempt) => attempt.action === "send" && (String(attempt.username || "").toLowerCase() === normalized || attempt.idempotencyKey === idempotencyKey));
  const resolvedAttemptIds = new Set(matchingSends.filter((attempt) => ["sent", "failed", "not-sent"].includes(attempt.outcome)).map((attempt) => attempt.attemptId));
  if (matchingSends.some((attempt) => attempt.outcome === "uncertain" && !resolvedAttemptIds.has(attempt.attemptId))) {
    return `@${username} has an uncertain prior delivery. Check X manually before any retry.`;
  }
  if (matchingSends.some((attempt) => attempt.outcome === "in-flight" && !resolvedAttemptIds.has(attempt.attemptId))) {
    return `@${username} has an unresolved in-flight attempt. Reconcile it manually before any retry.`;
  }
  return "";
}

function failureCircuitGuard(state) {
  const cutoff = Date.now() - 30 * 60 * 1000;
  const recentFailures = state.attempts.filter((attempt) => ["failed", "uncertain"].includes(attempt.outcome) && Date.parse(attempt.at) >= cutoff);
  return recentFailures.length >= 3 ? `X DM circuit breaker is open after ${recentFailures.length} failed or uncertain attempts in 30 minutes.` : "";
}

function cooldownGuard(state, minSeconds) {
  const lastSend = state.sends.at(-1);
  if (!lastSend?.sentAt || minSeconds <= 0) return "";
  const elapsed = (Date.now() - Date.parse(lastSend.sentAt)) / 1000;
  return elapsed < minSeconds ? `Cooldown active. Wait ${Math.ceil(minSeconds - elapsed)} seconds before another X DM.` : "";
}

function followSafetyGuard(state, maxPerDay, minSeconds) {
  const successful = state.attempts.filter((attempt) => attempt.action === "follow" && ["following", "already-following"].includes(attempt.outcome));
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = successful.filter((attempt) => String(attempt.at || "").startsWith(today) && attempt.outcome === "following").length;
  if (todayCount >= maxPerDay) return `Daily follow cap reached: ${todayCount}/${maxPerDay}.`;
  const lastFollow = successful.filter((attempt) => attempt.outcome === "following").at(-1);
  if (!lastFollow?.at || minSeconds <= 0) return "";
  const elapsed = (Date.now() - Date.parse(lastFollow.at)) / 1000;
  return elapsed < minSeconds ? `Follow cooldown active. Wait ${Math.ceil(minSeconds - elapsed)} seconds.` : "";
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  const operation = Promise.resolve(promise);
  operation.catch(() => {});
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms.`)), milliseconds); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function launchSession(config, profileDir) {
  await mkdir(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: boolArg(config.HEADLESS, true),
    executablePath: config.CHROME_EXECUTABLE_PATH || undefined,
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      ...chromiumCacheArgs(cacheBudgetBytes(config.BROWSER_CACHE_MAX_MB))
    ]
  });
  const browser = context.browser();
  activeBrowser = context;
  return { browser, context };
}

async function closeSession(session) {
  if (!session) return;
  await withTimeout(session.context.close().catch(() => {}), 6000, "X browser context close").catch(() => {});
  if (session.browser) await withTimeout(session.browser.close().catch(() => {}), 4000, "X browser close").catch(() => {});
  if (activeBrowser === session.context) activeBrowser = null;
}

async function detectAccount(page) {
  const switcher = page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').first();
  const switcherText = await switcher.innerText({ timeout: 3000 }).catch(() => "");
  const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const authenticatedMarker = await page.locator([
    '[data-testid="SideNav_AccountSwitcher_Button"]',
    '[data-testid="SideNav_NewTweet_Button"]',
    'a[href="/messages"]',
    'a[data-testid="AppTabBar_Home_Link"]'
  ].join(",")).first().isVisible().catch(() => false);
  const handleMatch = `${switcherText}\n${body}`.match(/@([A-Za-z0-9_]{1,15})/);
  return {
    loggedIn: Boolean(switcherText) || authenticatedMarker,
    handle: handleMatch ? handleMatch[1] : "",
    bodyHint: body.slice(0, 180).replace(/\s+/g, " ") || "X returned an empty or blocked page"
  };
}

async function validateSession(page, config) {
  const expected = cleanHandle(config.EXPECTED_ACCOUNT_HANDLE);
  let account = { loggedIn: false, handle: "", bodyHint: "X did not load" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt === 0) await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45000 });
    else await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForSelector('[data-testid="SideNav_AccountSwitcher_Button"], a[data-testid="AppTabBar_Home_Link"]', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2000);
    account = await detectAccount(page);
    if (account.loggedIn && (!expected || account.handle)) break;
  }
  if (!account.loggedIn) throw new Error(`X session is not logged in or needs verification. Hint: ${account.bodyHint}`);
  if (expected && !account.handle) throw new Error(`X account guard could not verify the expected @${expected} account; refusing the operation.`);
  if (expected && account.handle.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`X account guard failed: expected @${expected}, detected @${account.handle}.`);
  }
  return account;
}

async function openProfile(page, username) {
  let response = null;
  let body = "";
  let navigationError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (attempt === 0) response = await page.goto(`https://x.com/${encodeURIComponent(username)}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      else response = await page.goto(`https://x.com/${encodeURIComponent(username)}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      navigationError = null;
    } catch (error) {
      navigationError = error;
      if (attempt === 0) { await page.waitForTimeout(1500); continue; }
    }
    await page.waitForSelector('main, [data-testid="primaryColumn"]', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1800);
    body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    if (body.trim()) break;
  }
  if (!body.trim() && navigationError) throw navigationError;
  if (!body.trim()) throw new Error(`X returned an empty or blocked profile page for @${username}; DM availability is unknown.`);
  if (/This account doesn.?t exist|Account suspended|Profile not found/i.test(body)) throw new Error(`@${username} profile is not available.`);
  if (/Continue with|Sign in to X|Log in/i.test(body)) throw new Error("X session is not logged in or requires verification.");
  return { body, status: response?.status() || null, profileUrl: page.url() };
}

function profileUrlMatchesUsername(urlValue, username) {
  try {
    const url = new URL(urlValue);
    return /(^|\.)x\.com$/i.test(url.hostname) && url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() === username.toLowerCase();
  } catch { return false; }
}

async function describeFollowControl(locator, username, following) {
  if (!await locator.isVisible().catch(() => false) || !await locator.isEnabled().catch(() => false)) return null;
  const testId = await locator.getAttribute("data-testid").catch(() => "");
  const suffix = following ? "-unfollow" : "-follow";
  const idMatch = String(testId || "").match(new RegExp(`^(\\d+)${suffix}$`));
  if (!idMatch) return null;
  const ariaLabel = await locator.getAttribute("aria-label").catch(() => "");
  const text = (await locator.innerText().catch(() => "")).trim();
  const box = await locator.boundingBox().catch(() => null);
  const targetPattern = new RegExp(`@${escapedRegex(username)}\\b`, "i");
  const targetNamed = targetPattern.test(`${ariaLabel} ${text}`);
  const profileHeaderBound = Boolean(box && box.y >= 0 && box.y < 500);
  if (!targetNamed && !profileHeaderBound) return null;
  return { locator, targetUserId: idMatch[1], testId, ariaLabel, text, targetNamed, profileHeaderBound, boxY: box?.y ?? null };
}

async function profileFollowControl(page, username, following) {
  const suffix = following ? "-unfollow" : "-follow";
  const candidates = page.locator(`[data-testid="primaryColumn"] button[data-testid$="${suffix}"]`);
  const count = Math.min(await candidates.count().catch(() => 0), 10);
  for (let index = 0; index < count; index += 1) {
    const described = await describeFollowControl(candidates.nth(index), username, following);
    if (described) return described;
  }
  return null;
}

async function readFollowState(page, username) {
  const followingControl = await profileFollowControl(page, username, true);
  const followControl = await profileFollowControl(page, username, false);
  if (followingControl && followControl) {
    if (followingControl.targetNamed !== followControl.targetNamed) {
      return followingControl.targetNamed ? { following: true, control: followingControl } : { following: false, control: followControl };
    }
    const distance = Math.abs(Number(followingControl.boxY) - Number(followControl.boxY));
    if (distance >= 100) return followingControl.boxY < followControl.boxY ? { following: true, control: followingControl } : { following: false, control: followControl };
    throw new Error(`X exposed ambiguous relationship controls on @${username}; refusing the operation.`);
  }
  if (followingControl) return { following: true, control: followingControl };
  if (followControl) return { following: false, control: followControl };
  throw new Error(`X did not expose a target-bound Follow/Following control for @${username}.`);
}

async function waitForFollowState(page, username, expected, targetUserId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await readFollowState(page, username).catch(() => null);
    if (state?.following === expected && state.control.targetUserId === targetUserId) return state;
    await page.waitForTimeout(500);
  }
  throw new Error(`X did not verify the target-bound ${expected ? "Following" : "Follow"} state for @${username}.`);
}

function isCandidateRelationshipResponse(response, shouldFollow) {
  if (response.request().method() !== "POST") return false;
  try {
    const url = new URL(response.url());
    if (!/(^|\.)x\.com$/i.test(url.hostname)) return false;
    const action = `${url.pathname}${url.search}`;
    return shouldFollow
      ? /friendships\/create|(?:^|\/)(?:CreateFriendship|Follow)(?:[/?]|$)/i.test(action)
      : /friendships\/destroy|(?:^|\/)(?:DestroyFriendship|Unfollow)(?:[/?]|$)/i.test(action);
  } catch { return false; }
}

function nestedTargetValueMatches(value, targetUserId) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => nestedTargetValueMatches(item, targetUserId));
  return Object.entries(value).some(([key, nested]) =>
    (/^(?:target_)?user_id$/i.test(key) && String(nested) === targetUserId) || nestedTargetValueMatches(nested, targetUserId)
  );
}

function requestTargetsUser(request, targetUserId) {
  const raw = String(request.postData() || "");
  try {
    const parsed = JSON.parse(raw);
    if (nestedTargetValueMatches(parsed, targetUserId)) return true;
  } catch {}
  try {
    const params = new URLSearchParams(raw);
    if (["user_id", "target_user_id"].some((key) => params.get(key) === targetUserId)) return true;
  } catch {}
  return new RegExp(`(?:user_id|target_user_id)[^0-9]{0,20}${escapedRegex(targetUserId)}(?:\\D|$)`).test(raw);
}

async function buildRelationshipReceipt(response, targetUserId) {
  let responseJson = null;
  try { responseJson = await response.json(); } catch {}
  const statusOk = response.status() >= 200 && response.status() < 300;
  const noApplicationErrors = Boolean(responseJson) && !(Array.isArray(responseJson.errors) && responseJson.errors.length);
  const requestTargetMatches = requestTargetsUser(response.request(), targetUserId);
  return {
    valid: Boolean(statusOk && noApplicationErrors && requestTargetMatches),
    endpoint: (() => { try { return new URL(response.url()).pathname; } catch { return ""; } })(),
    status: response.status(),
    requestTargetMatches,
    noApplicationErrors,
    targetUserId
  };
}

async function performRelationshipChange(page, username, before, shouldFollow) {
  const responsePromises = [];
  const onResponse = (response) => {
    if (isCandidateRelationshipResponse(response, shouldFollow)) {
      responsePromises.push(buildRelationshipReceipt(response, before.control.targetUserId).catch(() => null));
    }
  };
  page.on("response", onResponse);
  let mutationStarted = false;
  try {
    await before.control.locator.click({ timeout: 10000 });
    if (!shouldFollow) {
      const dialog = page.locator('[role="dialog"]').filter({ hasText: new RegExp(escapedRegex(username), "i") }).first();
      const confirm = dialog.locator('[data-testid="confirmationSheetConfirm"]').first();
      await confirm.waitFor({ state: "visible", timeout: 10000 });
      mutationStarted = true;
      await confirm.click({ timeout: 10000 });
    } else {
      mutationStarted = true;
    }
    await waitForFollowState(page, username, shouldFollow, before.control.targetUserId);
    await page.waitForTimeout(1500);
  } catch (error) {
    if (mutationStarted) error.relationshipUncertain = true;
    throw error;
  } finally {
    page.off("response", onResponse);
  }
  const receipts = (await Promise.all(responsePromises)).filter(Boolean);
  const receipt = receipts.find((item) => item.valid) || null;
  const evidence = {
    targetUserId: before.control.targetUserId,
    domTransitionVerified: true,
    matchingReceipt: receipt,
    receiptCandidates: receipts.length
  };
  if (!receipt) {
    const error = new Error(`X relationship change for @${username} could not be proven with a target-matching receipt. Do not retry automatically.`);
    error.relationshipUncertain = true;
    error.relationshipEvidence = evidence;
    throw error;
  }
  return evidence;
}

async function changeFollowState(page, username, shouldFollow, beforeChange = async () => {}) {
  const profile = await openProfile(page, username);
  if (!profileUrlMatchesUsername(profile.profileUrl, username) || !new RegExp(`@${escapedRegex(username)}\\b`, "i").test(profile.body)) {
    throw new Error(`X profile binding for @${username} could not be verified; refusing the follow change.`);
  }
  const before = await readFollowState(page, username);
  if (before.following === shouldFollow) {
    return { changed: false, following: shouldFollow, profileUrl: profile.profileUrl, targetUserId: before.control.targetUserId, preexisting: true, evidence: null };
  }
  await beforeChange(before);
  const evidence = await performRelationshipChange(page, username, before, shouldFollow);
  return { changed: true, following: shouldFollow, profileUrl: profile.profileUrl, targetUserId: before.control.targetUserId, preexisting: false, evidence };
}

function normalizedBio(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function checkedBio(value) {
  const bio = normalizedBio(value);
  if (!bio) throw new Error("The X bio cannot be empty.");
  if ([...bio].length > 160) throw new Error("The X bio must be 160 characters or fewer.");
  return bio;
}

function comparableBio(value) {
  return normalizedBio(value).replace(/https?:\/\//gi, "");
}

function bioWithAppend(current, addition) {
  const base = normalizedBio(current);
  const extra = normalizedBio(addition);
  if (!extra) throw new Error("update-bio requires args.bio or args.appendText.");
  if (base.toLowerCase().includes(extra.toLowerCase())) return base;
  return checkedBio(base ? `${base} | ${extra}` : extra);
}

async function openOwnProfileEditor(page, handle) {
  const field = page.locator('textarea[name="description"], input[name="description"], [data-testid="Profile_Edit_Bio"]').first();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(`https://x.com/${encodeURIComponent(handle)}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    const editButton = page.locator('[data-testid="editProfileButton"]').first();
    await editButton.waitFor({ state: "visible", timeout: 15000 });
    await editButton.click();
    const visible = await field.waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false);
    if (visible) return field;
    await page.keyboard.press("Escape").catch(() => {});
  }
  const diagnostics = await page.locator('textarea, input, [contenteditable="true"]').evaluateAll((nodes) => nodes.map((node) => ({
    tag: node.tagName.toLowerCase(),
    name: node.getAttribute("name") || "",
    testid: node.getAttribute("data-testid") || "",
    aria: node.getAttribute("aria-label") || "",
    placeholder: node.getAttribute("placeholder") || "",
    contenteditable: node.getAttribute("contenteditable") || ""
  })).slice(0, 30)).catch(() => []);
  throw new Error(`X profile editor opened, but the bio field was not found. Fields: ${JSON.stringify(diagnostics)}`);
}

async function readOwnBio(page, handle) {
  const field = await openOwnProfileEditor(page, handle);
  const bio = normalizedBio(await field.inputValue());
  await page.keyboard.press("Escape").catch(() => {});
  return bio;
}

async function updateOwnBio(page, handle, desiredBio) {
  const field = await openOwnProfileEditor(page, handle);
  const previous = normalizedBio(await field.inputValue());
  if (previous === desiredBio) {
    await page.keyboard.press("Escape").catch(() => {});
    return { previous, bio: desiredBio, changed: false, verified: true };
  }
  await field.fill(desiredBio);
  const saveButton = page.locator('[data-testid="Profile_Save_Button"]').first();
  await saveButton.waitFor({ state: "visible", timeout: 10000 });
  if (await saveButton.isDisabled().catch(() => false)) throw new Error("X kept the profile Save button disabled.");
  await saveButton.click();
  await page.waitForSelector('[data-testid="Profile_Save_Button"]', { state: "detached", timeout: 15000 }).catch(() => {});
  const verifiedBio = await readOwnBio(page, handle);
  if (comparableBio(verifiedBio) !== comparableBio(desiredBio)) throw new Error("X did not retain the requested bio; refusing to report success.");
  return { previous, bio: verifiedBio, changed: true, verified: true };
}

async function readOwnPosts(page, handle, maxResults = 10) {
  await page.goto(`https://x.com/${encodeURIComponent(handle)}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  const tweets = page.locator('[data-testid="tweet"]');
  await tweets.first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  const count = Math.min(await tweets.count().catch(() => 0), Math.max(1, Math.min(maxResults, 25)));
  const posts = [];
  for (let index = 0; index < count; index += 1) {
    const tweet = tweets.nth(index);
    if (!await tweet.isVisible().catch(() => false)) continue;
    const text = await tweet.innerText().catch(() => "");
    const hrefs = await tweet.locator('a[href*="/status/"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href") || "")).catch(() => []);
    const href = hrefs.find((value) => /\/status\/\d+/.test(value)) || "";
    posts.push({ text, url: href ? new URL(href, "https://x.com").href : null });
  }
  const pageText = posts.length ? "" : await page.locator("main").innerText().catch(() => "");
  return { posts, pageHint: pageText.slice(0, 1200) };
}

function postTextFrom(request, args) {
  return String(args.post || args.message || request.text || request.artifact?.text || "").replace(/\r\n/g, "\n").trim();
}

function checkedPostText(value) {
  const post = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!post) throw new Error("create-post requires non-empty args.post or args.message.");
  if ([...post].length > 280) throw new Error("The X post must be 280 characters or fewer.");
  return post;
}

function postComparableText(value) {
  return String(value || "").normalize("NFC").replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
}

function tweetIdFromResponse(value) {
  if (!value || typeof value !== "object") return "";
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /^(?:rest_id|id_str)$/i.test(key) && /^\d{6,}$/.test(child)) return child;
    const nested = tweetIdFromResponse(child);
    if (nested) return nested;
  }
  return "";
}

function isCandidatePostResponse(response) {
  if (response.request().method() !== "POST") return false;
  try {
    const url = new URL(response.url());
    return /(^|\.)x\.com$/i.test(url.hostname) && /CreateTweet/i.test(`${url.pathname}${url.search}`);
  } catch { return false; }
}

async function openPostComposer(page, handle) {
  const context = page.context();
  page = await context.newPage();
  await page.goto(`https://x.com/${encodeURIComponent(handle)}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  const selector = '[data-testid="tweetTextarea_0"], [role="textbox"][contenteditable="true"]';
  let candidates = page.locator(selector);
  let composer = await firstVisibleEnabled(candidates);
  if (composer) return { page, composer };
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press("n");
  candidates = page.locator(selector);
  await candidates.first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  composer = await firstVisibleEnabled(candidates);
  if (!composer) {
    const diagnostics = page.isClosed() ? { url: page.url(), error: "post shortcut closed the page" } : await domDiagnostics(page, "Post");
    throw new Error(`X post composer was not available. Diagnostics: ${JSON.stringify(diagnostics)}`);
  }
  return { page, composer };
}

async function composePost(page, composer, post, { force = false } = {}) {
  await composer.click({ force });
  await composer.fill(post, { force });
  const actual = canonicalExactText(await composer.innerText().catch(() => ""));
  if (actual !== canonicalExactText(post)) throw new Error("X post composer did not retain the exact requested text.");
}

async function buildPostReceipt(response, post) {
  let requestJson = null;
  try { requestJson = JSON.parse(response.request().postData() || "null"); } catch {}
  let responseJson = null;
  try { responseJson = await response.json(); } catch {}
  const requestTextMatches = nestedValueMatches(requestJson, post);
  const statusOk = response.status() >= 200 && response.status() < 300;
  const noApplicationErrors = Boolean(responseJson) && !(Array.isArray(responseJson.errors) && responseJson.errors.length);
  const tweetId = createTweetResultId(responseJson) || tweetIdFromResponse(responseJson);
  return {
    valid: Boolean(requestTextMatches && statusOk && noApplicationErrors && tweetId),
    endpoint: (() => { try { return new URL(response.url()).pathname; } catch { return ""; } })(),
    status: response.status(),
    requestTextMatches,
    noApplicationErrors,
    responseTextMatches: nestedValueMatches(responseJson, post),
    tweetId: tweetId || null
  };
}

function createTweetResultId(value) {
  let result = value?.data?.create_tweet?.tweet_results?.result || null;
  if (result?.tweet) result = result.tweet;
  return typeof result?.rest_id === "string" && /^\d{6,}$/.test(result.rest_id) ? result.rest_id : "";
}

function escapedRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function verifyPublishedPost(page, handle, post, tweetId) {
  const url = `https://x.com/${encodeURIComponent(handle)}/status/${tweetId}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  const article = page.locator('[data-testid="tweet"]').first();
  await article.waitFor({ state: "visible", timeout: 20000 });
  const visibleText = postComparableText(await article.innerText());
  const expectedText = postComparableText(post);
  return { verified: Boolean(expectedText && visibleText.includes(expectedText)), url };
}

async function firstVisibleEnabled(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 20); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false) && await candidate.isEnabled().catch(() => true)) return candidate;
  }
  return null;
}

async function findDmButton(page) {
  const selectors = [
    '[data-testid="sendDMFromProfile"]',
    'a[href*="/messages/compose"]',
    'button[aria-label="Message"]',
    '[role="button"][aria-label="Message"]',
    'button[aria-label*="Message"]',
    '[role="button"][aria-label*="Message"]'
  ];
  for (const selector of selectors) {
    const button = await firstVisibleEnabled(page.locator(selector));
    if (button) return button;
  }
  return null;
}

function cleanVisibleText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

function profileIdentityFromHeader(lines, username) {
  const normalized = (lines || []).map((line) => cleanVisibleText(line)).filter(Boolean);
  const handleIndex = normalized.findIndex((line) => line.toLowerCase() === `@${String(username || "").toLowerCase()}`);
  if (handleIndex <= 0) return { handleVerified: false, displayName: "" };
  return { handleVerified: true, displayName: normalized[handleIndex - 1].slice(0, 100) };
}

async function inspectTarget(page, username) {
  const profile = await openProfile(page, username);
  const canDm = Boolean(await findDmButton(page));
  const lines = profile.body.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 12);
  const headerLines = (await page.locator('[data-testid="UserName"]').first().innerText().catch(() => ""))
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const identity = profileIdentityFromHeader(headerLines, username);
  const bio = cleanVisibleText(await page.locator('[data-testid="UserDescription"]').first().innerText().catch(() => "")).slice(0, 300);
  return {
    username,
    canDm,
    profileUrl: profile.profileUrl,
    httpStatus: profile.status,
    profileHint: lines.join(" | ").slice(0, 500),
    displayName: identity.handleVerified ? identity.displayName : "",
    bio,
    profileIdentityVerified: identity.handleVerified
  };
}

function conversationIdFromUrl(value) {
  const match = String(value || "").match(/^https:\/\/x\.com\/i\/chat\/([^/?#]+)$/i);
  return match ? match[1] : "";
}

async function proveStableConversation(page, username, waitMs = 12000, requiredStableTicks = 5) {
  const initialUrl = page.url();
  const conversationId = conversationIdFromUrl(initialUrl);
  if (!conversationId) return { ok: false, reason: `X did not open a concrete conversation for @${username}; current URL is ${initialUrl}.` };
  const deadline = Date.now() + waitMs;
  let stableTicks = 0;
  let lastUrl = initialUrl;
  let lastMissing = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    const currentUrl = page.url();
    lastUrl = currentUrl;
    const body = await page.locator("body").innerText({ timeout: 2500 }).catch(() => "");
    if (/\/i\/chat\/pin\//i.test(currentUrl) || /Enter Passcode|recover your encryption keys/i.test(body)) {
      return { ok: false, reason: "X Chat requires its passcode before this browser can prove or verify delivery.", blockedBy: "x-chat-passcode", conversationId, conversationUrl: `https://x.com/i/chat/${conversationId}` };
    }
    const composerVisible = await page.locator('[data-testid="dm-composer-textarea"]').isVisible().catch(() => false);
    const listVisible = await page.locator('[data-testid="dm-message-list"]').isVisible().catch(() => false);
    const bound = conversationIdFromUrl(currentUrl) === conversationId;
    if (bound && composerVisible && listVisible) {
      stableTicks += 1;
      if (stableTicks >= requiredStableTicks) {
        const recipientLabel = await page.locator('[data-testid="dm-conversation-username"]').innerText({ timeout: 2000 }).catch(() => "");
        return { ok: true, conversationId, conversationUrl: currentUrl, recipientLabel: recipientLabel.trim(), evidenceVersion: 2 };
      }
    } else {
      stableTicks = 0;
      lastMissing = !bound ? "conversation-navigation" : !composerVisible ? "composer" : "message-list";
    }
  }
  return { ok: false, reason: `X did not keep the target conversation stable before send; current URL is ${lastUrl}.`, blockedBy: lastMissing || "unstable-conversation", conversationId, conversationUrl: `https://x.com/i/chat/${conversationId}` };
}

async function scopedExactMessageCount(page, message) {
  return page.locator('[data-testid="dm-message-list"]').evaluate((list, expected) => {
    const canonical = (value) => String(value || "").normalize("NFC").replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
    let count = 0;
    for (const node of list.querySelectorAll("*")) {
      const own = canonical(node.innerText || node.textContent);
      if (own !== canonical(expected)) continue;
      const childAlsoMatches = [...node.children].some((child) => canonical(child.innerText || child.textContent) === canonical(expected));
      if (!childAlsoMatches) count += 1;
    }
    return count;
  }, message).catch(() => 0);
}

async function scopedMessageTexts(page) {
  return page.locator('[data-testid="dm-message-list"]').evaluate((list) => {
    const canonical = (value) => String(value || "").normalize("NFC").replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
    const texts = new Set();
    for (const node of list.querySelectorAll("*")) {
      const own = canonical(node.innerText || node.textContent);
      if (!own || own.length > 2000) continue;
      const childAlsoMatches = [...node.children].some((child) => canonical(child.innerText || child.textContent) === own);
      if (!childAlsoMatches) texts.add(own);
    }
    return [...texts];
  }).catch(() => []);
}

async function unlockXChatPasscode(page, passcode, returnUrl) {
  if (!passcode) return { ok: false, reason: "X Chat requires its passcode before this browser can prove or verify delivery.", blockedBy: "x-chat-passcode" };
  const container = page.locator('[data-testid="pin-code-input-container"]');
  await container.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  const inputs = container.locator("input");
  const count = await inputs.count();
  if (!count) return { ok: false, reason: "X Chat requested a passcode but its passcode input was not found.", blockedBy: "x-chat-passcode-ui" };
  if (count === 1) await inputs.first().fill(String(passcode), { timeout: 10000 });
  else {
    const digits = [...String(passcode)];
    if (digits.length !== count) return { ok: false, reason: `X Chat expects ${count} passcode characters.`, blockedBy: "x-chat-passcode-length" };
    for (let index = 0; index < count; index += 1) {
      const input = inputs.nth(index);
      await input.focus();
      await input.press(digits[index], { delay: 120 });
    }
  }
  await page.waitForURL((url) => !/\/i\/chat\/pin\//i.test(url.pathname), { timeout: 20000 }).catch(() => {});
  const body = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  if (/Incorrect passcode|Invalid passcode|Try again/i.test(body)) {
    return { ok: false, reason: "X Chat explicitly rejected the configured passcode.", blockedBy: "x-chat-passcode-rejected" };
  }
  if (/\/i\/chat\/pin\//i.test(page.url())) {
    return { ok: false, reason: "X Chat did not finish passcode recovery before the timeout.", blockedBy: "x-chat-passcode-timeout" };
  }
  if (page.url() !== returnUrl) await page.goto(returnUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  return page.url() === returnUrl
    ? { ok: true }
    : { ok: false, reason: "X Chat accepted the passcode but did not return to the target conversation.", blockedBy: "x-chat-passcode-navigation" };
}

async function openDmComposer(page, username, config = {}) {
  const target = await inspectTarget(page, username);
  if (!target.canDm) return { ok: false, reason: `No visible DM button for @${username}. They may not accept DMs from this account.`, target };
  const button = await findDmButton(page);
  let clickError = null;
  await button.click({ timeout: 10000, noWaitAfter: true }).catch((error) => { clickError = error; });
  await page.waitForURL(/\/messages|\/i\/chat/, { timeout: 20000 }).catch(() => {});
  if (clickError && !/\/messages|\/i\/chat/.test(page.url())) throw clickError;
  await page.waitForSelector([
    '[data-testid="dm-composer-textarea"]',
    '[data-testid="dmComposerTextInput"]',
    '[aria-label="Start a new message"]',
    'div[role="textbox"][contenteditable="true"]',
    'textarea'
  ].join(","), { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const input = await findComposerInput(page);
  if (input) {
    let binding = await proveStableConversation(page, username);
    if (!binding.ok && binding.blockedBy === "x-chat-passcode") {
      const unlocked = await unlockXChatPasscode(page, config.X_CHAT_PASSCODE, binding.conversationUrl || `https://x.com/i/chat/${binding.conversationId}`);
      if (!unlocked.ok) return { ok: false, reason: unlocked.reason, target: { ...target, ...binding, blockedBy: unlocked.blockedBy } };
      await page.waitForSelector('[data-testid="dm-composer-textarea"]', { timeout: 15000 }).catch(() => {});
      binding = await proveStableConversation(page, username, 15000, 10);
    }
    if (!binding.ok) return { ok: false, reason: binding.reason, target: { ...target, ...binding } };
    const reboundInput = await findComposerInput(page);
    if (!reboundInput) return { ok: false, reason: "The X Chat composer was not available after conversation validation.", target: { ...target, ...binding } };
    return { ok: true, input: reboundInput, target: { ...target, ...binding } };
  }
  const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  return { ok: false, reason: `DM composer did not open at ${page.url()}.`, target: { ...target, composerPageHint: body.slice(0, 800).replace(/\s+/g, " ") } };
}

async function findComposerInput(page) {
  const selectors = [
    '[data-testid="dm-composer-textarea"]',
    'textarea[data-testid="dm-composer-textarea"]',
    '[data-testid="dmComposerTextInput"]',
    '[aria-label="Start a new message"]',
    '[aria-label*="Start a new message"]',
    'div[role="textbox"][contenteditable="true"]'
  ];
  for (const selector of selectors) {
    const input = await firstVisibleEnabled(page.locator(selector));
    if (input) return input;
  }
  return null;
}

async function findSendButton(page) {
  const selectors = [
    '[data-testid="dmComposerSendButton"]',
    '[data-testid="dm-composer-send-button"]',
    'button[aria-label="Send"]',
    '[role="button"][aria-label="Send"]'
  ];
  for (const selector of selectors) {
    const button = await firstVisibleEnabled(page.locator(selector));
    if (button) return button;
  }
  return null;
}

async function composerText(input) {
  return input.evaluate((node) => "value" in node ? node.value : node.textContent || "").catch(() => "");
}

async function composeMessage(page, input, message) {
  await input.click({ timeout: 10000 });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  const tagName = await input.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
  if (tagName === "textarea" || tagName === "input") await input.fill(message, { timeout: 10000 });
  else await page.keyboard.insertText(message);
  await page.waitForTimeout(700);
  const composed = await composerText(input);
  if (composed.trim() !== message.trim()) throw new Error("DM composer content did not match the approved message.");
}

function canonicalExactText(value) {
  return String(value || "").normalize("NFC").replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
}

function nestedValueMatches(value, expected) {
  if (typeof value === "string") return canonicalExactText(value) === canonicalExactText(expected);
  if (Array.isArray(value)) return value.some((item) => nestedValueMatches(item, expected));
  if (value && typeof value === "object") return Object.values(value).some((item) => nestedValueMatches(item, expected));
  return false;
}

function nestedValueContains(value, expected) {
  if (typeof value === "string" || typeof value === "number") return String(value).includes(String(expected));
  if (Array.isArray(value)) return value.some((item) => nestedValueContains(item, expected));
  if (value && typeof value === "object") return Object.values(value).some((item) => nestedValueContains(item, expected));
  return false;
}

function responseStableId(value, key = "") {
  if (!value || typeof value !== "object") return "";
  for (const [childKey, child] of Object.entries(value)) {
    if (typeof child === "string" && /(?:message|event).*id|^(?:id|id_str)$/i.test(childKey) && /^[A-Za-z0-9_-]{6,}$/.test(child)) return child;
    const nested = responseStableId(child, childKey);
    if (nested) return nested;
  }
  return "";
}

function assessDeliveryEvidence(evidence) {
  const missing = [];
  if (!evidence.conversationBound) missing.push("target-conversation-binding");
  if (!evidence.composerCleared) missing.push("composer-clear");
  if (!(evidence.newScopedExactMessages > 0)) missing.push("new-exact-message-in-target-list");
  if (evidence.explicitError) missing.push("x-reported-send-error");
  if (!evidence.networkReceipt?.valid) missing.push("matching-x-send-receipt");
  return { verified: missing.length === 0, missing };
}

function isCandidateSendResponse(response) {
  const request = response.request();
  if (request.method() !== "POST") return false;
  try {
    const url = new URL(response.url());
    return /(^|\.)x\.com$/i.test(url.hostname) && /CreateDM|SendMessage|DirectMessage|\/dm\/|\/chat\/|messages/i.test(`${url.pathname}${url.search}`);
  } catch { return false; }
}

async function buildNetworkReceipt(response, message, conversationId) {
  const request = response.request();
  let requestJson = null;
  try { requestJson = JSON.parse(request.postData() || "null"); } catch {}
  let responseJson = null;
  try { responseJson = await response.json(); } catch {}
  const requestTextMatches = nestedValueMatches(requestJson, message);
  const requestConversationMatches = nestedValueContains(requestJson, conversationId);
  const statusOk = response.status() >= 200 && response.status() < 300;
  const noApplicationErrors = Boolean(responseJson) && !(Array.isArray(responseJson.errors) && responseJson.errors.length);
  const messageId = responseStableId(responseJson);
  return {
    valid: Boolean(requestTextMatches && requestConversationMatches && statusOk && noApplicationErrors && messageId),
    endpoint: (() => { try { return new URL(response.url()).pathname; } catch { return ""; } })(),
    status: response.status(),
    requestTextMatches,
    requestConversationMatches,
    noApplicationErrors,
    messageId: messageId || null
  };
}

async function verifyDelivery(page, input, message, binding, baselineCount) {
  const deadline = Date.now() + 15000;
  const evidence = {
    conversationBound: true,
    composerCleared: false,
    newScopedExactMessages: 0,
    explicitError: false
  };
  while (Date.now() < deadline) {
    const currentUrl = page.url();
    evidence.conversationBound = conversationIdFromUrl(currentUrl) === binding.conversationId;
    const body = await page.locator("body").innerText({ timeout: 2500 }).catch(() => "");
    evidence.explicitError = /Failed to send|Message not sent|Couldn.t send|Try again/i.test(body);
    evidence.composerCleared = (await composerText(input)).trim() === "";
    const currentCount = await scopedExactMessageCount(page, message);
    evidence.newScopedExactMessages = Math.max(0, currentCount - baselineCount);
    if (!evidence.conversationBound || evidence.explicitError || (evidence.composerCleared && evidence.newScopedExactMessages > 0)) break;
    await page.waitForTimeout(750);
  }
  return evidence;
}

async function sendDm(page, username, message, config) {
  const composer = await openDmComposer(page, username, config);
  if (!composer.ok) return composer;
  const binding = composer.target;
  const baselineCount = await scopedExactMessageCount(page, message);
  await composeMessage(page, composer.input, message);
  if (conversationIdFromUrl(page.url()) !== binding.conversationId) return { ok: false, reason: "X left the bound target conversation before send; nothing was sent.", target: binding };
  const sendButton = await findSendButton(page);
  if (!sendButton) return { ok: false, reason: "Explicit X DM send button was not found; nothing was sent.", target: binding };
  const responsePromises = [];
  const onResponse = (response) => {
    if (isCandidateSendResponse(response)) responsePromises.push(buildNetworkReceipt(response, message, binding.conversationId).catch(() => null));
  };
  page.on("response", onResponse);
  await sendButton.click({ timeout: 10000, noWaitAfter: true });
  const evidence = await verifyDelivery(page, composer.input, message, binding, baselineCount);
  await page.waitForTimeout(1200);
  page.off("response", onResponse);
  const receipts = (await Promise.all(responsePromises)).filter(Boolean);
  evidence.networkReceipt = receipts.find((item) => item.valid) || receipts[0] || null;
  evidence.receiptCandidates = receipts.length;
  const assessment = assessDeliveryEvidence(evidence);
  if (assessment.verified) {
    return { ok: true, verified: true, verificationMethod: "bound-conversation-new-exact-message-plus-x-receipt-v2", evidence, target: binding };
  }

  if (evidence.conversationBound && evidence.composerCleared && !evidence.explicitError) {
    await page.waitForTimeout(2500);
    const readback = await verifyDeliveryInConversation(page, username, message, binding.conversationId, config);
    evidence.deferredReadback = {
      verified: readback.verified,
      reason: readback.reason,
      exactCount: readback.exactCount || 0,
      conversationId: readback.target?.conversationId || null
    };
    if (readback.verified) {
      return { ok: true, verified: true, verificationMethod: "bound-conversation-deferred-exact-readback-v3", evidence, target: readback.target || binding };
    }
  }

  return { ok: false, uncertain: true, reason: `X send could not be proven. Missing evidence: ${assessment.missing.join(", ")}. Deferred conversation readback did not find the exact message. Do not retry until the conversation is checked.`, evidence, target: binding };
}

function handleFromStatusHref(value) {
  const match = String(value || "").match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
  return match ? { username: match[1], statusId: match[2] } : null;
}

async function searchX(page, args) {
  const query = String(args.query || "").trim();
  if (!query) throw new Error("args.query is required for action=search.");
  const mode = String(args.mode || "posts").toLowerCase() === "people" ? "people" : "posts";
  const maxResults = Math.max(1, Math.min(intArg(args.maxResults, 10), 25));
  const filter = mode === "people" ? "user" : "live";
  await page.goto(`https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=${filter}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  const selector = mode === "people" ? '[data-testid="UserCell"]' : '[data-testid="tweet"]';
  await page.waitForSelector(selector, { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(2200);
  const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  if (!body.trim()) throw new Error("X returned an empty or blocked search page.");
  if (/Something went wrong|Try reloading|rate limit|Verify your identity/i.test(body) && !(await page.locator(selector).count().catch(() => 0))) {
    throw new Error("X search is unavailable or requires verification.");
  }
  const items = [];
  const seen = new Set();
  const cells = page.locator(selector);
  const count = Math.min(await cells.count().catch(() => 0), maxResults * 3);
  for (let index = 0; index < count && items.length < maxResults; index += 1) {
    const cell = cells.nth(index);
    const text = (await cell.innerText().catch(() => "")).trim();
    if (!text) continue;
    let username = "";
    let evidenceUrl = "";
    if (mode === "posts") {
      const links = await cell.locator('a[href*="/status/"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href") || "")).catch(() => []);
      const status = links.map(handleFromStatusHref).find(Boolean);
      if (status) {
        username = status.username;
        evidenceUrl = `https://x.com/${status.username}/status/${status.statusId}`;
      }
    } else {
      const handleMatch = text.match(/@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/);
      username = handleMatch ? handleMatch[1] : "";
      if (username) evidenceUrl = `https://x.com/${username}`;
    }
    const key = username.toLowerCase();
    if (!username || seen.has(key)) continue;
    seen.add(key);
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    items.push({
      username,
      displayName: lines.find((line) => !line.startsWith("@")) || username,
      snippet: text.slice(0, 1000),
      evidenceUrl,
      mode
    });
  }
  return { query, mode, items, ...(items.length ? {} : { pageHint: body.slice(0, 500).replace(/\s+/g, " ") }) };
}

function normalizedConversationText(value) { return String(value || "").toLowerCase().replace(/https?:\/\/\S+/g, (url) => url.replace(/[),.!?]+$/, "")).replace(/[^\p{L}\p{N}:/.@_-]+/gu, " ").replace(/\s+/g, " ").trim(); }

async function openBoundConversation(page, username, expectedConversationId, config) {
  const composer = await openDmComposer(page, username, config);
  if (!composer.ok) return { ok: false, reason: composer.reason || "Could not open the target conversation.", target: composer.target };
  if (!expectedConversationId || composer.target.conversationId !== expectedConversationId) {
    return { ok: false, reason: "The opened X conversation does not match the conversation bound to the uncertain attempt.", target: composer.target };
  }
  return { ok: true, target: composer.target };
}

async function verifyDeliveryInConversation(page, username, message, expectedConversationId, config) {
  const conversation = await openBoundConversation(page, username, expectedConversationId, config);
  if (!conversation.ok) return { verified: false, reason: conversation.reason, target: conversation.target };
  const exactCount = await scopedExactMessageCount(page, message);
  return {
    verified: exactCount > 0,
    reason: exactCount > 0 ? "The exact approved message is visible inside the bound target message list." : "The exact approved message was not found inside the bound target message list.",
    target: conversation.target,
    exactCount
  };
}

async function verifyDeliveryHashInConversation(page, username, hash, expectedConversationId, config) {
  const conversation = await openBoundConversation(page, username, expectedConversationId, config);
  if (!conversation.ok) return { verified: false, reason: conversation.reason, target: conversation.target };
  const matchingCount = (await scopedMessageTexts(page)).filter((text) => messageHash(text) === hash).length;
  return {
    verified: matchingCount > 0,
    reason: matchingCount > 0 ? "A message matching the approved hash is visible inside the bound target message list." : "No message matching the approved hash was found inside the bound target message list.",
    target: conversation.target,
    exactCount: matchingCount
  };
}

async function reconcileVerifiedDelivery(request, args, stateDir, statePath, state, page, config) {
  const attemptId = String(args.attemptId || "").trim();
  const username = usernameFrom(args.username || request.text || request.artifact?.text || "", args);
  const suppliedHash = String(args.messageHash || "").trim().toLowerCase();
  const message = suppliedHash
    ? String(args.message || request.artifact?.text || "").replace(/\r\n/g, "\n").trim()
    : messageFrom(request, args);
  const hash = message ? messageHash(message) : suppliedHash;
  if (!attemptId || !username || !/^[a-f0-9]{16}$/.test(hash)) return toolError("verify-delivery requires attemptId, a valid username, and the exact approved message or its 16-character messageHash.");
  const records = state.attempts.filter((item) => item.attemptId === attemptId);
  const uncertain = records.find((item) => item.action === "send" && item.outcome === "uncertain" && String(item.username || "").toLowerCase() === username.toLowerCase() && item.messageHash === hash);
  const resolved = records.some((item) => ["sent", "failed", "not-sent"].includes(item.outcome));
  if (!uncertain || resolved) return toolError("No currently unresolved matching uncertain attempt exists.");
  if (!uncertain.conversationId) return toolError("The uncertain attempt predates conversation-bound evidence and cannot be reconciled automatically.");
  const verification = message
    ? await verifyDeliveryInConversation(page, username, message, uncertain.conversationId, config)
    : await verifyDeliveryHashInConversation(page, username, hash, uncertain.conversationId, config);
  if (!verification.verified) return toolOk({ text: `${verification.reason} Nothing was sent or retried.`, json: { username, attemptId, verified: false, verification } });
  const release = await acquireStateLock(stateDir);
  try {
    const latest = await readState(statePath);
    const latestRecords = latest.attempts.filter((item) => item.attemptId === attemptId);
    if (latestRecords.some((item) => ["sent", "failed", "not-sent"].includes(item.outcome))) return toolError("The uncertain attempt was already resolved.");
    const entry = {
      username,
      campaignId: uncertain.campaignId,
      idempotencyKey: uncertain.idempotencyKey,
      ...(message ? { message } : {}),
      messageHash: hash,
      sentAt: uncertain.at,
      deliveryVerified: true,
      verificationMethod: message ? "bound-conversation-scoped-readback-v2" : "bound-conversation-hash-readback-v3",
      evidenceVersion: message ? 2 : 3,
      conversationId: uncertain.conversationId,
      profileUrl: verification.target?.profileUrl || `https://x.com/${username}`
    };
    latest.sends = [...latest.sends, entry].slice(-5000);
    latest.recipientIndex[username.toLowerCase()] = { username, firstSentAt: entry.sentAt, lastSentAt: entry.sentAt, campaignId: entry.campaignId };
    appendAttempt(latest, { attemptId, action: "send", username, campaignId: entry.campaignId, idempotencyKey: entry.idempotencyKey, messageHash: hash, outcome: "sent", verificationMethod: entry.verificationMethod, conversationId: entry.conversationId, evidenceVersion: entry.evidenceVersion });
    await writeState(statePath, latest);
    return toolOk({ text: `Verified the approved X DM inside @${username}'s bound conversation.`, json: entry });
  } finally { await release(); }
}

async function statePaths(request) {
  const stateDir = request.chatId != null ? getChatToolStateDir(request.chatId, toolName) : getToolStateDir(toolName);
  await mkdir(stateDir, { recursive: true });
  return { stateDir, statePath: path.join(stateDir, "send-log.json") };
}

async function resolveUncertainAction(request, args) {
  if (!exactBoolean(args.confirm, true)) return toolError("resolve-uncertain requires exact confirm=true after human delivery confirmation.");
  const attemptId = String(args.attemptId || "").trim();
  if (!attemptId) return toolError("resolve-uncertain requires the exact uncertain attemptId.");
  const username = usernameFrom(args.username || request.text || request.artifact?.text || "", args);
  const suppliedHash = String(args.messageHash || "").trim().toLowerCase();
  const message = suppliedHash
    ? String(args.message || request.artifact?.text || "").replace(/\r\n/g, "\n").trim()
    : messageFrom(request, args);
  const hash = message ? messageHash(message) : suppliedHash;
  if (!username || !/^[a-f0-9]{16}$/.test(hash)) return toolError("resolve-uncertain requires a valid username and the exact approved message or its 16-character messageHash.");
  const { stateDir, statePath } = await statePaths(request);
  const release = await acquireStateLock(stateDir);
  try {
    const state = await readState(statePath);
    const records = state.attempts.filter((item) => item.attemptId === attemptId);
    const attempt = records.find((item) =>
      item.action === "send" && item.outcome === "uncertain" &&
      String(item.username || "").toLowerCase() === username.toLowerCase() &&
      item.messageHash === hash
    );
    if (!attempt) return toolError("No matching uncertain X DM attempt was found.");
    if (records.some((item) => ["sent", "failed", "not-sent"].includes(item.outcome))) return toolError("That uncertain X DM attempt was already resolved.");
    const resolution = String(args.outcome || "delivered").toLowerCase();
    if (!["delivered", "not-sent"].includes(resolution)) return toolError("outcome must be delivered or not-sent.");
    if (resolution === "not-sent") {
      appendAttempt(state, {
        attemptId: attempt.attemptId,
        action: "send",
        username,
        campaignId: attempt.campaignId,
        idempotencyKey: attempt.idempotencyKey,
        messageHash: hash,
        outcome: "not-sent",
        verificationMethod: "human-confirmed-not-sent"
      });
      await writeState(statePath, state);
      return toolOk({ text: `Resolved the uncertain X DM to @${username} as human-confirmed not sent.`, json: { username, attemptId: attempt.attemptId, outcome: "not-sent", idempotencyKey: attempt.idempotencyKey } });
    }
    let entry = state.sends.find((item) => item.idempotencyKey && item.idempotencyKey === attempt.idempotencyKey);
    if (!entry) {
      entry = {
        username,
        campaignId: attempt.campaignId || campaignIdFrom(args),
        idempotencyKey: attempt.idempotencyKey || null,
        ...(message ? { message } : {}),
        messageHash: hash,
        sentAt: attempt.at,
        deliveryVerified: true,
        verificationMethod: message ? "human-confirmed" : "human-confirmed-by-message-hash",
        userConfirmedAt: new Date().toISOString(),
        profileUrl: `https://x.com/${username}`
      };
      state.sends = [...state.sends, entry].slice(-5000);
    }
    state.recipientIndex[username.toLowerCase()] = {
      username,
      firstSentAt: entry.sentAt,
      lastSentAt: entry.sentAt,
      campaignId: entry.campaignId
    };
    appendAttempt(state, {
      attemptId: attempt.attemptId,
      action: "send",
      username,
      campaignId: entry.campaignId,
      idempotencyKey: entry.idempotencyKey,
      messageHash: hash,
      outcome: "sent",
      verificationMethod: entry.verificationMethod
    });
    await writeState(statePath, state);
    return toolOk({ text: `Resolved the uncertain X DM to @${username} as human-confirmed delivered.`, json: entry });
  } finally { await release(); }
}

async function auditAction(request, args) {
  const { stateDir, statePath } = await statePaths(request);
  const state = await readState(statePath);
  const campaignId = args.campaignId ? campaignIdFrom(args) : "";
  const entries = await readdir(stateDir, { withFileTypes: true }).catch(() => []);
  const staleProfileDirs = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("browser-profile-")).map((entry) => entry.name);
  const audit = { ...auditState(state, campaignId), staleBrowserProfiles: staleProfileDirs };
  if (exactBoolean(args.includeHistory, true)) {
    audit.history = {
      sendRecords: state.sends.map((entry) => ({
        username: entry.username,
        normalizedUsername: String(entry.username || "").toLowerCase(),
        campaignId: sentCampaignId(entry),
        idempotencyKey: entry.idempotencyKey || null,
        messageHash: entry.messageHash || null,
        sentAt: entry.sentAt || null,
        deliveryVerified: Boolean(entry.deliveryVerified)
      })),
      attemptRecords: state.attempts.filter((attempt) => attempt.action === "send").map((attempt) => ({
        attemptId: attempt.attemptId,
        username: attempt.username,
        normalizedUsername: String(attempt.username || "").toLowerCase(),
        campaignId: attempt.campaignId,
        idempotencyKey: attempt.idempotencyKey,
        messageHash: attempt.messageHash,
        outcome: attempt.outcome,
        at: attempt.at,
        reason: attempt.reason || null,
        verificationMethod: attempt.verificationMethod || null
      })),
      blockingAttempts: [...audit.uncertainDeliveries, ...audit.unresolvedAttempts].map((attempt) => ({
        attemptId: attempt.attemptId,
        username: attempt.username,
        campaignId: attempt.campaignId,
        idempotencyKey: attempt.idempotencyKey,
        messageHash: attempt.messageHash,
        outcome: attempt.outcome,
        at: attempt.at,
        reason: attempt.reason || null
      }))
    };
  }
  return toolOk({ text: `${audit.sent} X DM(s) recorded${campaignId ? ` for ${campaignId}` : ""}; ${audit.uncertainDeliveries.length} uncertain deliver${audit.uncertainDeliveries.length === 1 ? "y" : "ies"}.`, json: audit });
}

async function domDiagnostics(page, probeText = "") {
  return page.evaluate((probe) => {
    const compact = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const descriptors = [...document.querySelectorAll("[data-testid], [role], [aria-label]")].map((node) => ({
      tag: node.tagName.toLowerCase(),
      testid: node.getAttribute("data-testid") || "",
      role: node.getAttribute("role") || "",
      aria: compact(node.getAttribute("aria-label")),
      contenteditable: node.getAttribute("contenteditable") || ""
    }));
    const counts = new Map();
    for (const item of descriptors) {
      const key = JSON.stringify(item);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const elements = [...counts.entries()].map(([key, count]) => ({ ...JSON.parse(key), count })).sort((a, b) => b.count - a.count).slice(0, 150);
    const probeNormalized = compact(probe).toLowerCase();
    const matches = [];
    if (probeNormalized) {
      for (const node of document.querySelectorAll("body *")) {
        if (node.children.length > 0 || !compact(node.textContent).toLowerCase().includes(probeNormalized)) continue;
        const ancestry = [];
        let current = node;
        for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
          ancestry.push({
            tag: current.tagName.toLowerCase(),
            testid: current.getAttribute("data-testid") || "",
            role: current.getAttribute("role") || "",
            aria: compact(current.getAttribute("aria-label")),
            className: compact(current.className)
          });
        }
        matches.push({ text: compact(node.textContent), ancestry });
        if (matches.length >= 10) break;
      }
    }
    const inputs = [...document.querySelectorAll("input")].map((node) => ({ type: node.type, name: node.name, placeholder: compact(node.placeholder), maxLength: node.maxLength, testid: node.getAttribute("data-testid") || "", aria: compact(node.getAttribute("aria-label")) }));
    const buttons = [...document.querySelectorAll("button")].map((node) => ({ text: compact(node.innerText), testid: node.getAttribute("data-testid") || "", aria: compact(node.getAttribute("aria-label")), disabled: node.disabled })).filter((item) => item.text || item.testid || item.aria).slice(-30);
    return { url: location.href, title: document.title, bodyHint: compact(document.body?.innerText).slice(0, 1000), inputs, buttons, elements, matches };
  }, probeText).catch((error) => ({ url: page.url(), error: error.message, elements: [], matches: [] }));
}

async function publishPostViaUi(page, handle, post) {
  const opened = await openPostComposer(page, handle);
  const composerPage = opened.page;
  await composePost(composerPage, opened.composer, post, { force: true });
  const sendButton = composerPage.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').last();
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  if (await sendButton.isDisabled().catch(() => false)) throw new Error("X kept the Post button disabled.");
  const responsePromise = composerPage.waitForResponse(isCandidatePostResponse, { timeout: 30000 });
  await sendButton.click();
  const response = await responsePromise;
  const receipt = await buildPostReceipt(response, post);
  if (!receipt.valid) throw new Error("X UI post receipt did not verify the exact text.");
  return receipt;
}

async function createPostAction(request, args, stateDir, statePath, state, page, account, config) {
  const handle = cleanHandle(account.handle || config.EXPECTED_ACCOUNT_HANDLE);
  if (!handle) return toolError("Could not determine the logged-in X handle; refusing to create a post.");
  const post = checkedPostText(postTextFrom(request, args));
  const postHash = messageHash(post);
  const prior = state.posts.find((entry) => entry.messageHash === postHash);
  if (prior) return toolOk({
    text: `@${handle} already published this exact X post.`,
    json: { account: { handle }, duplicate: true, post: prior }
  });
  const unresolved = [...state.attempts].reverse().find((entry) => entry.action === "create-post" && entry.messageHash === postHash && entry.outcome === "uncertain");
  if (unresolved) return toolError(`A prior attempt to publish this exact X post is uncertain (${unresolved.attemptId}). Check the account manually before retrying.`);
  if (!exactBoolean(args.confirm, true)) return toolOk({
    text: `Dry run only. Would publish this exact post as @${handle}:

${post}

Pass confirm=true to publish it.`,
    json: { dryRun: true, account: { handle }, post, messageHash: postHash }
  });

  const attemptId = crypto.randomUUID();
  let clickStarted = false;
  let receipt = null;
  try {
    clickStarted = true;
    receipt = await publishPostViaUi(page, handle, post);
    const published = { verified: true, url: `https://x.com/${encodeURIComponent(handle)}/status/${receipt.tweetId}` };
    const record = {
      handle,
      post,
      messageHash: postHash,
      tweetId: receipt.tweetId,
      url: published.url,
      publishedAt: new Date().toISOString(),
      deliveryVerified: true,
      verificationMethod: "web-composer-create-tweet-receipt",
      receipt
    };
    const release = await acquireStateLock(stateDir);
    try {
      const latest = await readState(statePath);
      latest.posts.push(record);
      appendAttempt(latest, { attemptId, action: "create-post", messageHash: postHash, outcome: "published", tweetId: receipt.tweetId });
      await writeState(statePath, latest);
    } finally { await release(); }
    return toolOk({ text: `Published and verified an X post as @${handle}: ${published.url}`, json: { account: { handle }, post: record } });
  } catch (error) {
    const release = await acquireStateLock(stateDir);
    try {
      const latest = await readState(statePath);
      appendAttempt(latest, {
        attemptId,
        action: "create-post",
        messageHash: postHash,
        outcome: clickStarted ? "uncertain" : "failed",
        reason: error.message || String(error),
        ...(receipt?.tweetId ? { tweetId: receipt.tweetId } : {})
      });
      await writeState(statePath, latest);
    } finally { await release(); }
    if (clickStarted) throw new Error(`X post delivery could not be proven. Do not retry until the account is checked. ${error.message || error}`);
    throw error;
  }
}

function replyTarget(value) {
  const raw = String(value || "").trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error("reply-post requires a valid args.postUrl."); }
  if (!/(^|\.)x\.com$/i.test(url.hostname)) throw new Error("reply-post only accepts x.com post URLs.");
  const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
  if (!match) throw new Error("reply-post requires an exact X status URL.");
  return { username: match[1], tweetId: match[2], url: `https://x.com/${match[1]}/status/${match[2]}` };
}

function publicReplyGuard(state, target, config) {
  if (state.replies.some((entry) => entry.targetTweetId === target.tweetId)) throw new Error("This X post already received a campaign reply; refusing a duplicate.");
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const repliesToday = state.replies.filter((entry) => String(entry.repliedAt || "").startsWith(today));
  const cap = Math.max(1, Math.min(intArg(config.MAX_REPLIES_PER_DAY, 3), 10));
  if (repliesToday.length >= cap) throw new Error(`Daily public-reply cap reached (${cap}).`);
  const latest = state.replies.map((entry) => Date.parse(entry.repliedAt || "")).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const cooldownMs = Math.max(60, intArg(config.MIN_SECONDS_BETWEEN_REPLIES, 1800)) * 1000;
  if (latest && now - latest < cooldownMs) throw new Error(`Public-reply cooldown active for ${Math.ceil((cooldownMs - (now - latest)) / 1000)} more seconds.`);
}

async function getThreadAction(request, args, page) {
  const target = replyTarget(args.postUrl || request.text);
  await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  const tweets = page.locator('[data-testid="tweet"]');
  await tweets.first().waitFor({ state: "visible", timeout: 20000 });
  const count = Math.min(await tweets.count(), Math.max(1, Math.min(intArg(args.maxResults, 20), 50)));
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const tweet = tweets.nth(index);
    const text = await tweet.innerText().catch(() => "");
    const hrefs = await tweet.locator('a[href*="/status/"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href") || "")).catch(() => []);
    const href = hrefs.find((value) => /\/status\/\d+/.test(value)) || "";
    items.push({ text, url: href ? new URL(href, "https://x.com").href : null });
  }
  return toolOk({ text: `Read ${items.length} visible post(s) in the X thread.`, json: { target, items } });
}

async function findTargetPostArticle(page, target) {
  const articles = page.locator('[data-testid="tweet"]');
  const count = Math.min(await articles.count().catch(() => 0), 50);
  for (let index = 0; index < count; index += 1) {
    const article = articles.nth(index);
    const hrefs = await article.locator('a[href*="/status/"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href") || "")).catch(() => []);
    if (hrefs.some((href) => new RegExp(`/status/${target.tweetId}(?:$|[/?#])`).test(href))) return article;
  }
  return null;
}

async function openBoundReplyTarget(page, target, targetText = "") {
  await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  let article = await findTargetPostArticle(page, target);
  if (article || !String(targetText || "").trim()) return article;
  const query = `from:${target.username} \"${String(targetText).replace(/[\"\n\r]+/g, " ").trim()}\"`;
  await page.goto(`https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.locator('[data-testid="tweet"]').first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  return findTargetPostArticle(page, target);
}

async function replyPostAction(request, args, stateDir, statePath, state, page, account, config) {
  const target = replyTarget(args.postUrl);
  const reply = checkedPostText(args.reply || args.message || request.text);
  if (/https?:\/\//i.test(reply)) throw new Error("Campaign public replies must not contain links.");
  if (!/castle bravo/i.test(reply)) throw new Error("Campaign public replies must name Castle Bravo transparently.");
  publicReplyGuard(state, target, config);
  const hash = messageHash(reply);
  const uncertain = [...state.attempts].reverse().find((entry) => entry.action === "reply-post" && entry.targetTweetId === target.tweetId && entry.outcome === "uncertain");
  if (uncertain) throw new Error(`A prior reply attempt on this post is uncertain (${uncertain.attemptId}); never retry it automatically.`);
  if (!(exactBoolean(args.confirm, true) && exactBoolean(args.dryRun, false))) return toolOk({
    text: `Dry run only. Would reply to ${target.url}:\n\n${reply}\n\nPass confirm=true and dryRun=false to publish exactly this reply.`,
    json: { dryRun: true, target, reply, messageHash: hash }
  });

  const article = await openBoundReplyTarget(page, target, args.targetText);
  if (!article) throw new Error("The exact target post was not visible in its thread or verified search results.");
  const replyButton = article.locator('[data-testid="reply"]').first();
  await replyButton.waitFor({ state: "visible", timeout: 10000 });
  await replyButton.click();
  const composer = page.locator('[data-testid="tweetTextarea_0"], [role="textbox"][contenteditable="true"]').last();
  await composer.waitFor({ state: "visible", timeout: 15000 });
  await composePost(page, composer, reply, { force: true });
  const sendButton = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').last();
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  if (await sendButton.isDisabled().catch(() => false)) throw new Error("X kept the Reply button disabled.");

  const attemptId = crypto.randomUUID();
  let submitStarted = false;
  try {
    const responsePromise = page.waitForResponse(isCandidatePostResponse, { timeout: 30000 });
    submitStarted = true;
    await sendButton.click();
    const response = await responsePromise;
    const receipt = await buildPostReceipt(response, reply);
    let requestJson = null;
    try { requestJson = JSON.parse(response.request().postData() || "null"); } catch {}
    if (!receipt.valid || !nestedValueMatches(requestJson, target.tweetId)) throw new Error("X reply receipt did not bind the exact text to the target post.");
    const record = {
      campaignId: String(args.campaignId || "public-reply").trim(),
      targetUsername: target.username,
      targetTweetId: target.tweetId,
      targetUrl: target.url,
      reply,
      messageHash: hash,
      replyTweetId: receipt.tweetId,
      url: `https://x.com/${encodeURIComponent(account.handle)}/status/${receipt.tweetId}`,
      repliedAt: new Date().toISOString(),
      deliveryVerified: true,
      verificationMethod: "target-bound-create-tweet-receipt",
      receipt
    };
    const release = await acquireStateLock(stateDir);
    try {
      const latest = await readState(statePath);
      latest.replies.push(record);
      appendAttempt(latest, { attemptId, action: "reply-post", targetTweetId: target.tweetId, messageHash: hash, outcome: "published", tweetId: receipt.tweetId });
      await writeState(statePath, latest);
    } finally { await release(); }
    return toolOk({ text: `Published and verified the X reply: ${record.url}`, json: { account: { handle: account.handle }, reply: record } });
  } catch (error) {
    const release = await acquireStateLock(stateDir);
    try {
      const latest = await readState(statePath);
      appendAttempt(latest, { attemptId, action: "reply-post", targetTweetId: target.tweetId, messageHash: hash, outcome: submitStarted ? "uncertain" : "failed", reason: error.message || String(error) });
      await writeState(statePath, latest);
    } finally { await release(); }
    if (submitStarted) throw new Error(`X reply delivery could not be proven. Treat it as sent and do not retry. ${error.message || error}`);
    throw error;
  }
}

async function relationshipStatusAction(request, args, page, account) {
  const username = usernameFrom(args.username || request.text || request.artifact?.text || "", args);
  if (!username) return toolError("A valid args.username, @handle, or X profile URL is required.");
  const profile = await openProfile(page, username);
  if (!profileUrlMatchesUsername(profile.profileUrl, username) || !new RegExp(`@${escapedRegex(username)}\\b`, "i").test(profile.body)) {
    return toolError(`X profile binding for @${username} could not be verified.`);
  }
  const state = await readFollowState(page, username);
  return toolOk({
    text: `@${username} is ${state.following ? "currently followed" : "not currently followed"} by @${account.handle || "the logged-in account"}.`,
    json: {
      account: { handle: account.handle },
      relationship: {
        username,
        following: state.following,
        targetUserId: state.control.targetUserId,
        testId: state.control.testId,
        ariaLabel: state.control.ariaLabel,
        targetNamed: state.control.targetNamed,
        profileHeaderBound: state.control.profileHeaderBound,
        profileUrl: profile.profileUrl
      }
    }
  });
}

async function followAction(request, args, stateDir, statePath, page, account, config, shouldFollow) {
  const username = usernameFrom(args.username || request.text || request.artifact?.text || "", args);
  if (!username) return toolError("A valid args.username, @handle, or X profile URL is required.");
  const campaignId = campaignIdFrom(args);
  if (!exactBoolean(args.confirm, true)) return toolOk({
    text: `Dry run only. Would ${shouldFollow ? "follow" : "unfollow"} @${username} as @${account.handle || config.EXPECTED_ACCOUNT_HANDLE || "the logged-in account"}. Pass confirm=true to apply it.`,
    json: { dryRun: true, username, campaignId, action: shouldFollow ? "follow" : "unfollow" }
  });

  const initial = await readState(statePath);
  const key = username.toLowerCase();
  const existing = initial.follows[key] || null;
  if (existing?.status === "manual-review") return toolError(`@${username} has an uncertain prior relationship change; check X manually before another follow action.`);
  if (!shouldFollow) {
    if (!exactBoolean(args.noResponseConfirmed, true)) return toolError("unfollow requires exact noResponseConfirmed=true after checking that the recipient did not respond.");
    if (!existing?.followedByTool || existing.status !== "following") return toolError(`@${username} was not recorded as actively followed by this tool; refusing to unfollow.`);
    if (!existing.unfollowIfNoResponse) return toolError(`@${username} was not marked for no-response unfollow; refusing to unfollow.`);
    const verifiedSend = initial.sends.find((send) =>
      send.deliveryVerified === true &&
      normalizedUsername(send.username) === key &&
      send.campaignId === campaignId &&
      (!existing.followedAt || Date.parse(send.sentAt) >= Date.parse(existing.followedAt))
    );
    if (!verifiedSend) return toolError(`No verified DM sent after the managed follow to @${username}; refusing to unfollow.`);
  }

  let result;
  try {
    result = await changeFollowState(page, username, shouldFollow, async () => {
    if (!shouldFollow) return;
    const latest = await readState(statePath);
    const guard = followSafetyGuard(
      latest,
      Math.max(intArg(config.MAX_FOLLOWS_PER_DAY, 20), 1),
      Math.max(intArg(config.MIN_SECONDS_BETWEEN_FOLLOWS, 300), 60)
    );
      if (guard) throw new Error(guard);
    });
  } catch (error) {
    if (error.relationshipUncertain) {
      const release = await acquireStateLock(stateDir);
      try {
        const latest = await readState(statePath);
        latest.follows[key] = {
          ...(latest.follows[key] || {}),
          username,
          campaignId,
          status: "manual-review",
          unfollowIfNoResponse: false,
          lastError: error.message || String(error),
          evidence: error.relationshipEvidence || null,
          updatedAt: new Date().toISOString()
        };
        appendAttempt(latest, { action: shouldFollow ? "follow" : "unfollow", username, campaignId, outcome: "uncertain", reason: error.message || String(error), evidence: error.relationshipEvidence || null });
        await writeState(statePath, latest);
      } finally { await release(); }
    }
    throw error;
  }

  const release = await acquireStateLock(stateDir);
  try {
    const latest = await readState(statePath);
    const previous = latest.follows[key] || null;
    if (shouldFollow) {
      const followedByTool = result.changed || Boolean(previous?.followedByTool);
      latest.follows[key] = {
        username,
        campaignId,
        profileUrl: result.profileUrl,
        targetUserId: result.targetUserId,
        status: "following",
        followedByTool,
        preexisting: !result.changed && !previous?.followedByTool,
        unfollowIfNoResponse: followedByTool && exactBoolean(args.unfollowIfNoResponse, true),
        followedAt: result.changed ? new Date().toISOString() : previous?.followedAt || null,
        observedAt: new Date().toISOString(),
        verificationMethod: result.changed ? "target-dom-transition-plus-x-receipt" : "target-dom-preexisting",
        evidence: result.evidence
      };
      appendAttempt(latest, { action: "follow", username, campaignId, outcome: result.changed ? "following" : "already-following", followedByTool, targetUserId: result.targetUserId, verificationMethod: latest.follows[key].verificationMethod });
    } else {
      latest.follows[key] = {
        ...previous,
        status: "unfollowed",
        unfollowedAt: new Date().toISOString(),
        noResponseConfirmedAt: new Date().toISOString()
      };
      appendAttempt(latest, { action: "unfollow", username, campaignId, outcome: result.changed ? "unfollowed" : "already-unfollowed" });
    }
    await writeState(statePath, latest);
    const record = latest.follows[key];
    return toolOk({
      text: shouldFollow
        ? result.changed ? `Followed and verified @${username}.` : `@${username} was already followed; no follow click was needed.`
        : result.changed ? `Unfollowed and verified @${username}.` : `@${username} was already unfollowed.`,
      json: { account: { handle: account.handle }, follow: record, changed: result.changed }
    });
  } finally { await release(); }
}

async function browserAction(request, args, config) {
  const cookies = parseCookies(config.X_COOKIES);
  if (!cookies.length) return toolError("Could not parse X_COOKIES. Use JSON cookies, Netscape cookies.txt, or a raw Cookie header.");
  const { stateDir } = await statePaths(request);
  const releaseBrowserLock = await acquireStateLock(stateDir, "browser.lock");
  const profileDir = path.join(stateDir, "browser-profile");
  const maxCacheBytes = cacheBudgetBytes(config.BROWSER_CACHE_MAX_MB);
  let session;
  try {
    await pruneChromiumCaches(profileDir, maxCacheBytes);
    session = await launchSession(config, profileDir);
    await session.context.addCookies(cookies);
    const page = await session.context.newPage();
    const account = await validateSession(page, config);
    const { statePath } = await statePaths(request);
    const state = await readState(statePath);
    const action = String(args.action || "status").toLowerCase();
    if (action === "get-posts") {
      const handle = cleanHandle(account.handle || config.EXPECTED_ACCOUNT_HANDLE);
      if (!handle) return toolError("Could not determine the logged-in X handle; refusing to read its posts.");
      const result = await readOwnPosts(page, handle, intArg(args.maxResults, 10));
      return toolOk({ text: `Found ${result.posts.length} visible post(s) for @${handle}.`, json: { account: { handle }, ...result } });
    }
    if (action === "create-post") return await createPostAction(request, args, stateDir, statePath, state, page, account, config);
    if (action === "get-thread") return await getThreadAction(request, args, page);
    if (action === "reply-post") return await replyPostAction(request, args, stateDir, statePath, state, page, account, config);
    if (action === "get-bio" || action === "update-bio") {
      const handle = cleanHandle(account.handle || config.EXPECTED_ACCOUNT_HANDLE);
      if (!handle) return toolError("Could not determine the logged-in X handle; refusing the profile operation.");
      const current = await readOwnBio(page, handle);
      if (action === "get-bio") return toolOk({ text: `@${handle} bio: ${current || "(empty)"}`, json: { account: { handle }, bio: current } });
      const desired = normalizedBio(args.appendText) ? bioWithAppend(current, args.appendText) : checkedBio(args.bio);
      if (!exactBoolean(args.confirm, true)) return toolOk({
        text: `Dry run only. Would change @${handle}'s bio to:

${desired}

Pass confirm=true to apply exactly this bio.`,
        json: { dryRun: true, account: { handle }, previous: current, bio: desired }
      });
      const result = await updateOwnBio(page, handle, desired);
      return toolOk({
        text: result.changed ? `Updated and verified @${handle}'s X bio.` : `@${handle}'s X bio already matched the requested text.`,
        json: { account: { handle }, ...result }
      });
    }
    if (action === "status") {
      const campaignId = args.campaignId ? campaignIdFrom(args) : "";
      return toolOk({ text: `X session is logged in${account.handle ? ` as @${account.handle}` : ""}. ${auditState(state, campaignId).sent} DM(s) recorded.`, json: { account, campaign: auditState(state, campaignId) } });
    }
    if (action === "search") {
      const search = await searchX(page, args);
      return toolOk({ text: `Found ${search.items.length} X ${search.mode} result(s) for ${search.query}.`, json: { account, ...search } });
    }
    if (action === "verify-delivery") {
      const { stateDir } = await statePaths(request);
      return await reconcileVerifiedDelivery(request, args, stateDir, statePath, state, page, config);
    }
    if (action === "relationship-status") return await relationshipStatusAction(request, args, page, account);
    if (action === "follow" || action === "unfollow") {
      return await followAction(request, args, stateDir, statePath, page, account, config, action === "follow");
    }
    const username = usernameFrom(args.username || request.text || request.artifact?.text || "", args);
    if (!username) return toolError("A valid args.username, @handle, or X profile URL is required.");
    if (String(args.action).toLowerCase() === "check") {
      let target;
      let checkError = null;
      try {
        if (exactBoolean(args.verifyComposer, true)) {
          const diagnosePasscodeUi = exactBoolean(args.diagnosePasscodeUi, true);
          const composer = await openDmComposer(page, username, diagnosePasscodeUi ? { ...config, X_CHAT_PASSCODE: "" } : config);
          if (!composer.ok && diagnosePasscodeUi && composer.target?.blockedBy === "x-chat-passcode") {
            target = { ...composer.target, canDm: false, composerVerified: false, reason: composer.reason, domDiagnostics: await domDiagnostics(page, "") };
          } else if (!composer.ok && composer.target?.blockedBy === "x-chat-passcode" && !config.X_CHAT_PASSCODE) {
            return toolNeedsConfig({
              tool: toolName,
              missingConfig: ["X_CHAT_PASSCODE"],
              configPath: request.chatId != null ? getChatToolConfigPath(request.chatId, toolName) : getToolConfigPath(toolName),
              message: "X Chat requires its passcode to bind the conversation and verify delivery."
            });
          }
          if (!target) target = { ...(composer.target || { username, profileUrl: `https://x.com/${username}` }), canDm: Boolean(composer.ok), composerVerified: Boolean(composer.ok), ...(composer.ok ? { conversationUrl: page.url() } : { reason: composer.reason }) };
          if (composer.ok && exactBoolean(args.inspectDom, true)) {
            await page.waitForTimeout(Math.max(0, Math.min(intArg(args.inspectWaitMs, 5000), 15000)));
            target.domDiagnostics = await domDiagnostics(page, String(args.probeText || ""));
          }
        } else {
          target = await inspectTarget(page, username);
        }
      } catch (error) { checkError = error; }
      const release = await acquireStateLock((await statePaths(request)).stateDir);
      try {
        const latest = await readState(statePath);
        appendAttempt(latest, {
          action: "check",
          username,
          outcome: checkError ? "failed" : target.canDm ? "dm-available" : "dm-unavailable",
          ...(checkError ? { reason: checkError.message || String(checkError) } : {})
        });
        await writeState(statePath, latest);
      } finally { await release(); }
      if (checkError) throw checkError;
      return toolOk({ text: target.canDm ? `@${username} has a visible DM button.` : `No visible DM button for @${username}.`, json: { account, target } });
    }
    return await sendAction(request, args, config, page, account);
  } finally {
    await closeSession(session);
    await pruneChromiumCaches(profileDir, maxCacheBytes).catch(() => {});
    await releaseBrowserLock();
  }
}

async function sendAction(request, args, config, page, account) {
  const username = usernameFrom(args.username || request.text || request.artifact?.text || "", args);
  const message = messageFrom(request, args);
  const campaignId = campaignIdFrom(args);
  if (!message) return toolError("args.message or text is required for action=send.");
  if (message.length > 1000) return toolError("DM message is too long; keep it under 1000 characters.");
  const confirmed = exactBoolean(args.confirm, true) && exactBoolean(args.dryRun, false);
  if (!confirmed) return toolOk({
    text: `Dry run only. Would DM @${username} for campaign ${campaignId}:\n\n${message}\n\nPass confirm=true and dryRun=false to send exactly this message.`,
    json: { dryRun: true, username, campaignId, message, messageHash: messageHash(message), account }
  });

  const { stateDir, statePath } = await statePaths(request);
  const release = await acquireStateLock(stateDir);
  try {
    const state = await readState(statePath);
    const hash = messageHash(message);
    const idempotencyKey = String(args.idempotencyKey || `${campaignId}:${username.toLowerCase()}:${hash}`).slice(0, 200);
    const duplicate = duplicateGuard(state, username, idempotencyKey);
    if (duplicate) return toolError(duplicate);
    const circuit = failureCircuitGuard(state);
    if (circuit) return toolError(circuit);
    const cooldown = cooldownGuard(state, Math.max(intArg(config.MIN_SECONDS_BETWEEN_SENDS, 90), 60));
    if (cooldown) return toolError(cooldown);
    const cap = withinDailyCap(
      state,
      campaignId,
      Math.max(intArg(config.MAX_SENDS_PER_DAY, 20), 1),
      Math.max(intArg(config.MAX_SENDS_PER_CAMPAIGN_PER_DAY, 20), 1)
    );
    if (!cap.allowed) return toolError(`Daily cap reached: global ${cap.globalCount}/${cap.globalMax}, ${campaignId} ${cap.campaignCount}/${cap.campaignMax}.`);

    const reservation = appendAttempt(state, { action: "send", username, campaignId, idempotencyKey, messageHash: hash, outcome: "in-flight" });
    await writeState(statePath, state);
    const result = await sendDm(page, username, message, config);
    if (!result.ok && result.target?.blockedBy === "x-chat-passcode" && !config.X_CHAT_PASSCODE) {
      appendAttempt(state, { attemptId: reservation.attemptId, action: "send", username, campaignId, idempotencyKey, messageHash: hash, outcome: "failed", reason: result.reason, conversationId: result.target.conversationId || null, evidenceVersion: 2 });
      await writeState(statePath, state);
      return toolNeedsConfig({
        tool: toolName,
        missingConfig: ["X_CHAT_PASSCODE"],
        configPath: request.chatId != null ? getChatToolConfigPath(request.chatId, toolName) : getToolConfigPath(toolName),
        message: "X Chat requires its passcode before this browser can send and verify delivery."
      });
    }
    if (!result.ok) {
      appendAttempt(state, { attemptId: reservation.attemptId, action: "send", username, campaignId, idempotencyKey, messageHash: hash, outcome: result.uncertain ? "uncertain" : "failed", reason: result.reason, conversationId: result.target?.conversationId || null, evidenceVersion: result.target?.evidenceVersion || null, evidence: result.evidence || null });
      await writeState(statePath, state);
      return toolError(result.reason || "DM send failed.");
    }
    const entry = {
      username,
      campaignId,
      idempotencyKey,
      message,
      messageHash: hash,
      sentAt: new Date().toISOString(),
      deliveryVerified: true,
      verificationMethod: result.verificationMethod || "conversation-readback",
      evidenceVersion: result.target?.evidenceVersion || 2,
      conversationId: result.target?.conversationId || null,
      messageId: result.evidence?.networkReceipt?.messageId || null,
      receiptEndpoint: result.evidence?.networkReceipt?.endpoint || null,
      receiptStatus: result.evidence?.networkReceipt?.status || null,
      profileUrl: result.target?.profileUrl || `https://x.com/${username}`
    };
    state.sends = [...state.sends, entry].slice(-5000);
    state.recipientIndex[username.toLowerCase()] = { username, firstSentAt: entry.sentAt, lastSentAt: entry.sentAt, campaignId };
    appendAttempt(state, { attemptId: reservation.attemptId, action: "send", username, campaignId, idempotencyKey, messageHash: entry.messageHash, outcome: "sent", conversationId: entry.conversationId, messageId: entry.messageId, verificationMethod: entry.verificationMethod, evidenceVersion: entry.evidenceVersion });
    await writeState(statePath, state);
    return toolOk({ text: `Sent and verified X DM to @${username}.`, json: entry });
  } finally {
    await release();
  }
}

async function execute(requestFile) {
  const request = JSON.parse((await readFile(requestFile, "utf8")).replace(/^\uFEFF/, ""));
  const args = request.args || {};
  const action = String(args.action || "status").toLowerCase();
  if (action === "audit") return auditAction(request, args);
  if (action === "resolve-uncertain") return resolveUncertainAction(request, args);
  if (!["status", "check", "search", "verify-delivery", "get-bio", "get-posts", "get-thread", "update-bio", "create-post", "reply-post", "relationship-status", "follow", "unfollow", "send"].includes(action)) return toolError(`Unknown action: ${action}`);
  if (["relationship-status", "follow", "unfollow", "send"].includes(action)) {
    const username = usernameFrom(args.username || request.text || request.artifact?.text || "", args);
    if (!username) return toolError("A valid args.username, @handle, or X profile URL is required.");
  }
  const config = await loadConfig(request);
  if (!config.X_COOKIES) return toolNeedsConfig({
    tool: toolName,
    missingConfig: ["X_COOKIES"],
    configPath: request.chatId != null ? getChatToolConfigPath(request.chatId, toolName) : getToolConfigPath(toolName),
    message: "I need X/Twitter cookies to use the web session."
  });
  const timeoutMs = Math.min(Math.max(intArg(config.OPERATION_TIMEOUT_MS, 120000), 30000), 180000);
  return withTimeout(browserAction(request, { ...args, action }, config), timeoutMs, `X ${action} operation`);
}

async function emergencyExit(message) {
  if (!outputWritten) {
    process.stdout.write(`${JSON.stringify(toolError(message))}\n`);
    outputWritten = true;
  }
  if (activeBrowser) await withTimeout(activeBrowser.close().catch(() => {}), 3000, "Emergency browser close").catch(() => {});
  process.exit(1);
}

async function main(cliArgs = process.argv.slice(2)) {
  if (!cliArgs.length || cliArgs.includes("--help") || cliArgs[0] === "help") {
    printHelp();
    return;
  }
  if (cliArgs[0] !== "run") {
    printHelp();
    return;
  }
  const fileIndex = cliArgs.indexOf("--request-file");
  const requestFile = cliArgs[fileIndex + 1];
  if (!requestFile) {
    console.log(JSON.stringify(toolError("--request-file is required.")));
    return;
  }
  const watchdog = setTimeout(() => { emergencyExit("X DM process exceeded its absolute 185-second lifetime."); }, 185000);
  try {
    const result = await execute(requestFile);
    console.log(JSON.stringify(result));
    outputWritten = true;
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
    outputWritten = true;
  } finally {
    clearTimeout(watchdog);
    if (activeBrowser) await withTimeout(activeBrowser.close().catch(() => {}), 3000, "Final browser close").catch(() => {});
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await main();

export {
  assessDeliveryEvidence,
  auditState,
  bioWithAppend,
  campaignIdFrom,
  checkedBio,
  checkedPostText,
  comparableBio,
  createTweetResultId,
  cooldownGuard,
  duplicateGuard,
  exactBoolean,
  failureCircuitGuard,
  followSafetyGuard,
  isCandidateRelationshipResponse,
  messageHash,
  normalizeState,
  parseCookies,
  profileIdentityFromHeader,
  publicReplyGuard,
  replyTarget,
  requestTargetsUser,
  usernameFrom,
  withinDailyCap
};
