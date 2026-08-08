import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import defaults from "./config.js";

const toolName = "x-campaign-runner";
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || process.env.ARISA_INSTALL_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { getChatToolStateDir, getChatToolTmpDir } = await importCore("runtime/paths.js");
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { createArisaClient } = await importCore("core/tools/ipc-client.js");
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");

function printHelp() {
  console.log(`x-campaign-runner

Usage:
  node index.js --help
  node index.js run --request-file <json>

Profile-driven organic X outreach for one carefully selected candidate at a time.

Actions:
  status      Show discovery and outreach state. args: profile?
  discover    Rotate search queries and persist relevant X candidates. args: profile?, needed?
  prepare-next Discover if needed, validate candidates through x-dm, personalize one message, and persist one approval. args: profile?, maxChecks?
  send-approved Send exactly the persisted approval. args: profile?, approvalId, messageHash, confirm=true, dryRun=false
  skip         Skip one pending approval. args: profile?, approvalId, reason?
  reconcile    Reconcile a manual-review approval from x-dm history without sending. args: profile?, approvalId
  resolve-not-sent Reopen a candidate only after x-dm records human-confirmed non-delivery. args: profile?, approvalId

Safety:
  - discovery and preparation never send
  - an actual send requires a matching persisted approvalId and messageHash plus exact confirm=true and dryRun=false
  - prior x-dm recipients are always excluded
  - every candidate retains public evidence and a discovery query
  - at most one DM can be sent per invocation
  - x-dm independently enforces account pinning, locking, idempotency, cooldown, caps, and delivery verification

Profiles live at:
  <chatToolStateDir>/profiles/<profile>.json
`);
}

function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function exactBoolean(value, expected) {
  if (typeof value === "boolean") return value === expected;
  return String(value || "").trim().toLowerCase() === String(expected);
}
function intArg(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function stableHash(value) {
  let total = 2166136261;
  for (const character of String(value)) total = Math.imul(total ^ character.charCodeAt(0), 16777619) >>> 0;
  return total;
}
function sha256(value) { return crypto.createHash("sha256").update(String(value), "utf8").digest("hex"); }
function unique(values) { return [...new Set(values.map(clean).filter(Boolean))]; }
function normalizedHandle(value) { return clean(value).replace(/^@/, "").toLowerCase(); }
function validHandle(value) { return /^[A-Za-z0-9_]{1,15}$/.test(clean(value)); }

async function runTool(arisa, name, args, timeoutMs = 120000, text = "") {
  const request = { name, args };
  if (text) request.text = text;
  const result = await arisa.tools.run(request, { timeoutMs });
  if (!result.ok) throw new Error(result.error || `${name} failed`);
  if (result.output?.json !== undefined) return result.output.json;
  const outputText = result.output?.text || "";
  try { return JSON.parse(outputText || "{}"); }
  catch { return { text: outputText }; }
}

async function readJson(file, fallback) {
  try { return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`Could not read ${path.basename(file)}: ${error.message || error}`);
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `﻿${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function acquireRunLock(chatId) {
  const tmpDir = getChatToolTmpDir(chatId, toolName);
  const lockFile = path.join(tmpDir, "run.lock");
  await mkdir(tmpDir, { recursive: true });
  try {
    const info = await stat(lockFile);
    if (Date.now() - info.mtimeMs > 10 * 60 * 1000) await rm(lockFile, { force: true });
  } catch {}
  const handle = await open(lockFile, "wx").catch((error) => {
    if (error?.code === "EEXIST") throw new Error("Another X campaign run is already active for this chat.");
    throw error;
  });
  await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
  return async () => {
    await handle.close().catch(() => {});
    await rm(lockFile, { force: true }).catch(() => {});
    await rm(tmpDir, { recursive: false }).catch(() => {});
  };
}

function profileName(args) {
  const name = clean(args.profile || defaults.DEFAULT_PROFILE || "default");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Invalid profile name.");
  return name;
}

async function loadProfile(chatId, name) {
  const stateDir = getChatToolStateDir(chatId, toolName);
  const file = path.join(stateDir, "profiles", `${name}.json`);
  const profile = await readJson(file, null);
  if (!profile) throw new Error(`Profile not found: ${name}`);
  return { profile, file, stateDir };
}

function emptyState() {
  return { version: 1, cursor: 0, creativeCursor: 0, seenUrls: {}, candidates: [], approval: null, runs: [], updatedAt: null };
}

async function loadState(stateDir, profileNameValue) {
  const file = path.join(stateDir, `${profileNameValue}-state.json`);
  const state = { ...emptyState(), ...(await readJson(file, emptyState())) };
  state.candidates = Array.isArray(state.candidates) ? state.candidates : [];
  state.runs = Array.isArray(state.runs) ? state.runs : [];
  state.seenUrls = state.seenUrls && typeof state.seenUrls === "object" ? state.seenUrls : {};
  return { file, state };
}

function parseSearchResults(text) {
  const lines = String(text || "").split(/\r?\n/);
  const results = [];
  let current = null;
  for (const line of lines) {
    const title = line.match(/^\s*\d+\.\s+(.+)$/);
    if (title) {
      if (current?.url) results.push(current);
      current = { title: clean(title[1]), url: "", snippet: "" };
      continue;
    }
    const url = line.match(/^URL:\s*(https?:\/\/\S+)/i);
    if (url && current) { current.url = url[1]; continue; }
    const snippet = line.match(/^Snippet:\s*(.*)$/i);
    if (snippet && current) { current.snippet = clean(snippet[1]); continue; }
    if (current?.url && clean(line) && !/^Search:|^Source:/i.test(line)) current.snippet = clean(`${current.snippet} ${line}`);
  }
  if (current?.url) results.push(current);
  return results;
}

function decodeHtml(value) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, entity) => {
    if (entity[0] === "#") {
      const numeric = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : "";
    }
    return named[entity.toLowerCase()] || "";
  });
}

function stripHtml(value) { return clean(decodeHtml(String(value || "").replace(/<[^>]+>/g, " "))); }

function unwrapDuckDuckGoUrl(value) {
  try {
    const absolute = value.startsWith("//") ? `https:${value}` : value;
    const url = new URL(absolute, "https://duckduckgo.com");
    return url.searchParams.get("uddg") || url.href;
  } catch { return value; }
}

async function searchDuckDuckGo(query, maxResults) {
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Arisa organic outreach research)", "Accept": "text/html; charset=UTF-8" },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`DuckDuckGo search returned HTTP ${response.status}.`);
  const html = await response.text();
  const results = [];
  const blocks = html.split(/<div[^>]+class="[^"]*result[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    results.push({ title: stripHtml(link[2]), url: unwrapDuckDuckGoUrl(decodeHtml(link[1])), snippet: stripHtml(snippet?.[1] || "") });
    if (results.length >= maxResults) break;
  }
  return results;
}

function handleFromXUrl(value) {
  try {
    const url = new URL(value);
    if (!/(^|\.)(x|twitter)\.com$/i.test(url.hostname)) return "";
    const first = url.pathname.split("/").filter(Boolean)[0] || "";
    const reserved = new Set(["home", "search", "explore", "messages", "i", "intent", "share", "hashtag", "settings"]);
    return validHandle(first) && !reserved.has(first.toLowerCase()) ? first : "";
  } catch { return ""; }
}

function displayNameFrom(result, handle) {
  const title = clean(result.title)
    .replace(/\s*\(@?[A-Za-z0-9_]{1,15}\).*$/i, "")
    .replace(/\s+on X:\s*.*$/i, "")
    .replace(/\s*\/\s*(?:Posts\s*\/\s*)?X\s*$/i, "")
    .replace(/\s*\(@?[A-Za-z0-9_]{1,15}\)\s*$/i, "");
  return title && title.length <= 80 ? title : handle;
}

function referenceFrom(query, result, profile) {
  const haystack = `${query} ${result.title} ${result.snippet}`.toLowerCase();
  const references = profile.discovery?.references || [];
  const matched = references.find((reference) => haystack.includes(String(reference).toLowerCase()));
  return matched || clean(result.title).slice(0, 120) || "narrative mystery games";
}

function candidateScore(candidate, profile) {
  const text = `${candidate.query} ${candidate.evidenceTitle} ${candidate.snippet} ${candidate.reference}`.toLowerCase();
  let score = 0;
  for (const keyword of profile.selection?.highValueKeywords || []) if (text.includes(String(keyword).toLowerCase())) score += 4;
  for (const keyword of profile.selection?.includeKeywords || []) if (text.includes(String(keyword).toLowerCase())) score += 2;
  for (const keyword of profile.selection?.excludeKeywords || []) if (text.includes(String(keyword).toLowerCase())) score -= 8;
  if (/review|creator|journalist|curator|games|gaming|indie|mobile|mystery|detective|interactive fiction|visual novel/.test(text)) score += 3;
  if (/giveaway|crypto|casino|agency|marketing service|paid promotion/.test(text)) score -= 12;
  return score;
}

function queryCatalog(profile, creative = false) {
  const discovery = profile.discovery || {};
  const queries = creative ? discovery.creativeQueries || [] : discovery.queries || [];
  return unique(queries).sort((a, b) => stableHash(a) - stableHash(b));
}

function nextQueries(profile, state, creative = false) {
  const catalog = queryCatalog(profile, creative);
  if (!catalog.length) return [];
  const settings = profile.discovery || {};
  const count = Math.max(1, Math.min(intArg(creative ? settings.creativeQueryBudgetPerRun : settings.queryBudgetPerRun, creative ? 4 : 3), catalog.length));
  const key = creative ? "creativeCursor" : "cursor";
  return Array.from({ length: count }, (_, offset) => catalog[(Number(state[key] || 0) + offset) % catalog.length]);
}

function mergeSeedCandidates(state, profile, excluded) {
  const existing = new Set(state.candidates.map((candidate) => normalizedHandle(candidate.username)));
  const added = [];
  for (const seed of profile.seedCandidates || []) {
    const username = clean(seed.username).replace(/^@/, "");
    const key = normalizedHandle(username);
    if (!validHandle(username) || existing.has(key) || excluded.has(key)) continue;
    const candidate = {
      username,
      displayName: clean(seed.displayName || username),
      reference: clean(seed.reference || "narrative mystery games"),
      evidenceTitle: clean(seed.evidenceTitle || seed.reference || username),
      evidenceUrl: clean(seed.evidenceUrl || `https://x.com/${username}`),
      snippet: clean(seed.snippet),
      query: "profile seed",
      discoveredAt: new Date().toISOString(),
      status: "discovered",
      source: "profile-seed"
    };
    candidate.score = candidateScore(candidate, profile) + intArg(seed.scoreBoost, 0);
    state.candidates.push(candidate);
    existing.add(key);
    added.push(candidate);
  }
  return added;
}

async function discoverCandidates(arisa, profile, state, excluded, needed, creative = false) {
  const discovery = profile.discovery || {};
  const webTool = discovery.webTool || "web-browser";
  const xSearchTool = discovery.xSearchTool || profile.dmTool || "x-dm";
  const queries = nextQueries(profile, state, creative);
  const catalog = queryCatalog(profile, creative);
  const cursorKey = creative ? "creativeCursor" : "cursor";
  const existing = new Set(state.candidates.map((candidate) => normalizedHandle(candidate.username)));
  const added = [];
  let searches = 0;
  const errors = [];

  const addCandidate = (item, query, source) => {
    const username = clean(item.username || handleFromXUrl(item.evidenceUrl || item.url)).replace(/^@/, "");
    const key = normalizedHandle(username);
    const profileExcluded = new Set((profile.selection?.excludeHandles || []).map(normalizedHandle));
    if (!validHandle(username) || existing.has(key) || excluded.has(key) || profileExcluded.has(key)) return;
    const result = { title: item.displayName || item.title || username, snippet: item.snippet || "", url: item.evidenceUrl || item.url || `https://x.com/${username}` };
    const text = `${result.title} ${result.snippet}`.toLowerCase();
    if ((profile.selection?.excludeKeywords || []).some((word) => text.includes(String(word).toLowerCase()))) return;
    const candidate = {
      username,
      displayName: clean(item.displayName || displayNameFrom(result, username)),
      reference: referenceFrom(query, result, profile),
      evidenceTitle: clean(result.title),
      evidenceUrl: clean(result.url),
      snippet: clean(result.snippet),
      query,
      discoveredAt: new Date().toISOString(),
      status: "discovered",
      source
    };
    candidate.score = candidateScore(candidate, profile);
    if (candidate.score < intArg(profile.selection?.minimumScore, 3)) return;
    state.candidates.push(candidate);
    existing.add(key);
    added.push(candidate);
  };

  for (const query of queries) {
    if (added.length >= needed) break;
    let xSearchWorked = false;
    if (discovery.xSearchEnabled !== false) {
      try {
        const output = await runTool(arisa, xSearchTool, { action: "search", query, mode: "posts", maxResults: String(discovery.maxResults || 10) }, intArg(discovery.xSearchTimeoutMs, 150000));
        searches += 1;
        xSearchWorked = Array.isArray(output.items) && output.items.length > 0;
        for (const item of output.items || []) {
          addCandidate(item, query, creative ? "creative-x-search" : "standard-x-search");
          if (added.length >= needed) break;
        }
      } catch (error) { errors.push({ query, source: "x-search", error: clean(error.message || error).slice(0, 300) }); }
    }
    if (xSearchWorked || added.length >= needed) continue;
    let webResults = [];
    try {
      const output = await runTool(arisa, webTool, { mode: "search", maxResults: String(discovery.maxResults || 10) }, intArg(discovery.timeoutMs, 90000), query);
      searches += 1;
      webResults = parseSearchResults(output.text);
    } catch (error) { errors.push({ query, source: "web-search", error: clean(error.message || error).slice(0, 300) }); }
    if (!webResults.length && discovery.duckDuckGoFallback !== false) {
      try {
        webResults = await searchDuckDuckGo(query, intArg(discovery.maxResults, 10));
        searches += 1;
      } catch (error) { errors.push({ query, source: "duckduckgo", error: clean(error.message || error).slice(0, 300) }); }
    }
    for (const result of webResults) {
      const username = handleFromXUrl(result.url);
      if (!username) continue;
      addCandidate({ username, displayName: displayNameFrom(result, username), snippet: result.snippet, evidenceUrl: result.url, title: result.title }, query, creative ? "creative-web-search" : "standard-web-search");
      if (added.length >= needed) break;
    }
  }
  state[cursorKey] = (Number(state[cursorKey] || 0) + queries.length) % Math.max(1, catalog.length);
  return { mode: creative ? "creative" : "standard", queries, searches, added, errors };
}

function availableCandidates(state, excluded) {
  return state.candidates.filter((candidate) =>
    !excluded.has(normalizedHandle(candidate.username)) &&
    candidate.status === "discovered"
  ).sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.discoveredAt).localeCompare(String(b.discoveredAt)));
}

function personalOpening(candidate, profile) {
  const reference = clean(candidate.reference || candidate.evidenceTitle || "narrative mystery games");
  const template = clean(profile.message?.openingTemplate || "I saw your {{reference}} coverage and thought Castle Bravo could fit your audience.");
  return template.replace(/{{\s*reference\s*}}/g, reference).replace(/{{\s*name\s*}}/g, clean(candidate.displayName || candidate.username));
}

function renderMessage(candidate, profile) {
  const greetingName = clean(candidate.displayName || candidate.username).split(/[|–—]/)[0].trim().slice(0, 50) || candidate.username;
  const body = String(profile.message?.body || "").trim();
  const message = `Hi ${greetingName}, ${personalOpening(candidate, profile)}\n\n${body}`
    .replace(/{{\s*siteUrl\s*}}/g, clean(profile.siteUrl))
    .replace(/{{\s*username\s*}}/g, clean(candidate.username))
    .replace(/\s*[—–]\s*/g, ", ")
    .trim();
  if (!message || message.length > 1000) throw new Error(`Rendered X DM is invalid (${message.length} characters).`);
  return message;
}

async function priorRecipients(arisa, profile) {
  const audit = await runTool(arisa, profile.dmTool || "x-dm", { action: "audit" }, 30000);
  return { audit, recipients: new Set((audit.recipients || []).map(normalizedHandle)) };
}

async function discoveryPass(arisa, profile, state, excluded, needed) {
  const seeded = mergeSeedCandidates(state, profile, excluded);
  let standard = { mode: "standard", queries: [], searches: 0, added: [], errors: [] };
  let creative = null;
  const remaining = Math.max(0, needed - seeded.length);
  if (remaining > 0) standard = await discoverCandidates(arisa, profile, state, excluded, remaining, false);
  if (seeded.length + standard.added.length === 0 && profile.discovery?.creativeEnabled !== false) {
    creative = await discoverCandidates(arisa, profile, state, excluded, needed, true);
  }
  return { seeded, standard, creative };
}

function runRecord(action, detail = {}) {
  return { at: new Date().toISOString(), action, ...detail };
}

async function handleStatus(request, args) {
  const name = profileName(args);
  const { profile, stateDir } = await loadProfile(request.chatId, name);
  const { state } = await loadState(stateDir, name);
  const arisa = createArisaClient({ toolName, chatId: request.chatId });
  const prior = await priorRecipients(arisa, profile);
  const available = availableCandidates(state, prior.recipients);
  const approval = pendingApproval(state) || state.approval;
  return toolOk({
    text: `${name}: ${state.candidates.length} candidate(s), ${available.length} available, ${prior.audit.sent || 0} prior DM record(s)${approval ? `; approval ${approval.status} for @${approval.username}` : ""}.`,
    json: { profile: name, campaignId: profile.campaignId, candidates: state.candidates.length, available: available.length, priorDmRecords: prior.audit.sent || 0, approval: approval || null, recentRuns: state.runs.slice(-10) }
  });
}

async function handleDiscover(request, args) {
  const name = profileName(args);
  const { profile, stateDir } = await loadProfile(request.chatId, name);
  const { file, state } = await loadState(stateDir, name);
  const arisa = createArisaClient({ toolName, chatId: request.chatId });
  const prior = await priorRecipients(arisa, profile);
  const needed = Math.max(1, Math.min(intArg(args.needed, 8), 25));
  const discovery = await discoveryPass(arisa, profile, state, prior.recipients, needed);
  const found = discovery.seeded.length + discovery.standard.added.length + (discovery.creative?.added.length || 0);
  state.runs = [...state.runs, runRecord("discover", { found, queries: [...discovery.standard.queries, ...(discovery.creative?.queries || [])] })].slice(-200);
  state.updatedAt = new Date().toISOString();
  await writeJson(file, state);
  return toolOk({ text: `Discovered ${found} new X candidate(s).`, json: { profile: name, found, discovery, available: availableCandidates(state, prior.recipients).slice(0, 20) } });
}

function pendingApproval(state) {
  const approval = state.approval;
  if (!approval || approval.status !== "pending") return null;
  if (Date.parse(approval.expiresAt) <= Date.now()) {
    approval.status = "expired";
    approval.expiredAt = new Date().toISOString();
    return null;
  }
  return approval;
}

async function handlePrepareNext(request, args) {
  const release = await acquireRunLock(request.chatId);
  try {
    const name = profileName(args);
    const { profile, stateDir } = await loadProfile(request.chatId, name);
    const { file, state } = await loadState(stateDir, name);
    const existingApproval = pendingApproval(state);
    if (existingApproval) {
      return toolOk({ text: `Approval ${existingApproval.id} for @${existingApproval.username} is still pending; nothing was sent.`, json: { profile: name, approval: existingApproval, reused: true } });
    }
    const arisa = createArisaClient({ toolName, chatId: request.chatId });
    const prior = await priorRecipients(arisa, profile);
    let pool = availableCandidates(state, prior.recipients);
    let discovery = null;
    if (pool.length < intArg(profile.discovery?.minimumPool, 3)) {
      discovery = await discoveryPass(arisa, profile, state, prior.recipients, Math.max(1, intArg(profile.discovery?.targetPool, 8) - pool.length));
      pool = availableCandidates(state, prior.recipients);
    }
    const maxChecks = Math.max(1, Math.min(intArg(args.maxChecks, 4), 10));
    const checked = [];
    for (const candidate of pool.slice(0, maxChecks)) {
      try {
        const check = await runTool(arisa, profile.dmTool || "x-dm", { action: "check", username: candidate.username, verifyComposer: "true" }, intArg(profile.dmCheckTimeoutMs, 150000));
        checked.push({ username: candidate.username, canDm: Boolean(check.target?.canDm) });
        candidate.lastCheckedAt = new Date().toISOString();
        candidate.profileHint = check.target?.profileHint || "";
        if (!check.target?.canDm) { candidate.status = "unavailable"; continue; }
        const message = renderMessage(candidate, profile);
        const createdAt = new Date();
        const ttlHours = Math.max(1, Math.min(intArg(profile.message?.approvalTtlHours, 24), 168));
        const approval = {
          id: crypto.randomUUID(),
          profileName: name,
          campaignId: profile.campaignId || name,
          profileDigest: sha256(JSON.stringify(profile)),
          username: candidate.username,
          displayName: candidate.displayName,
          message,
          messageHash: sha256(message),
          idempotencyKey: `${profile.campaignId || name}:${normalizedHandle(candidate.username)}:${sha256(message).slice(0, 16)}`,
          evidence: { title: candidate.evidenceTitle, url: candidate.evidenceUrl, snippet: candidate.snippet, reference: candidate.reference },
          createdAt: createdAt.toISOString(),
          expiresAt: new Date(createdAt.getTime() + ttlHours * 60 * 60 * 1000).toISOString(),
          status: "pending"
        };
        candidate.proposedAt = approval.createdAt;
        candidate.status = "awaiting-approval";
        candidate.proposedMessageHash = approval.messageHash;
        state.approval = approval;
        state.runs = [...state.runs, runRecord("prepare", { approvalId: approval.id, username: candidate.username })].slice(-200);
        state.updatedAt = new Date().toISOString();
        await writeJson(file, state);
        return toolOk({ text: `Prepared approval ${approval.id} for @${candidate.username}; nothing was sent.`, json: { profile: name, approval, candidate, checked, discovery } });
      } catch (error) {
        candidate.lastCheckedAt = new Date().toISOString();
        candidate.lastError = clean(error.message || error).slice(0, 300);
        candidate.failures = Number(candidate.failures || 0) + 1;
        if (candidate.failures >= 2) candidate.status = "check-failed";
        checked.push({ username: candidate.username, error: candidate.lastError });
      }
    }
    state.runs = [...state.runs, runRecord("no-approval", { checked })].slice(-200);
    state.updatedAt = new Date().toISOString();
    await writeJson(file, state);
    return toolOk({ text: "No verified DM-capable candidate was found in this bounded run; nothing was sent.", json: { profile: name, checked, discovery, available: availableCandidates(state, prior.recipients).length } });
  } finally { await release(); }
}

async function handleSendApproved(request, args) {
  const release = await acquireRunLock(request.chatId);
  try {
    const name = profileName(args);
    const { profile, stateDir } = await loadProfile(request.chatId, name);
    const { file, state } = await loadState(stateDir, name);
    const approval = pendingApproval(state);
    if (!approval) throw new Error("No unexpired pending approval exists for this campaign.");
    if (clean(args.approvalId) !== approval.id) throw new Error("approvalId does not match the pending approval.");
    if (clean(args.messageHash) !== approval.messageHash) throw new Error("messageHash does not match the approved message.");
    if (approval.profileDigest !== sha256(JSON.stringify(profile))) throw new Error("Campaign profile changed after preparation; create a fresh approval.");
    if (!exactBoolean(args.confirm, true) || !exactBoolean(args.dryRun, false)) throw new Error("Sending requires exact confirm=true and dryRun=false.");
    const arisa = createArisaClient({ toolName, chatId: request.chatId });
    const prior = await priorRecipients(arisa, profile);
    if (prior.recipients.has(normalizedHandle(approval.username))) {
      approval.status = "blocked-prior-recipient";
      approval.blockedAt = new Date().toISOString();
      await writeJson(file, state);
      throw new Error(`@${approval.username} is already present in X DM history.`);
    }
    try {
      const sent = await runTool(arisa, profile.dmTool || "x-dm", {
        action: "send",
        username: approval.username,
        campaignId: approval.campaignId,
        message: approval.message,
        confirm: "true",
        dryRun: "false",
        idempotencyKey: approval.idempotencyKey
      }, intArg(profile.dmSendTimeoutMs, 180000));
      approval.status = "sent";
      approval.sentAt = sent.sentAt || new Date().toISOString();
      approval.deliveryVerified = Boolean(sent.deliveryVerified);
      const candidate = state.candidates.find((item) => normalizedHandle(item.username) === normalizedHandle(approval.username));
      if (candidate) { candidate.status = "sent"; candidate.sentAt = approval.sentAt; candidate.deliveryVerified = approval.deliveryVerified; }
      state.runs = [...state.runs, runRecord("send-approved", { approvalId: approval.id, username: approval.username, deliveryVerified: approval.deliveryVerified })].slice(-200);
      state.updatedAt = new Date().toISOString();
      await writeJson(file, state);
      return toolOk({ text: `Sent approved X campaign DM to @${approval.username}.`, json: { profile: name, approval, sent } });
    } catch (error) {
      const reason = clean(error.message || error).slice(0, 500);
      if (/uncertain|in-flight|delivery could not be verified/i.test(reason)) approval.status = "manual-review";
      else if (!/cooldown|daily cap|another X DM operation/i.test(reason)) approval.status = "failed";
      approval.lastError = reason;
      approval.lastAttemptAt = new Date().toISOString();
      const candidate = state.candidates.find((item) => normalizedHandle(item.username) === normalizedHandle(approval.username));
      if (candidate && approval.status !== "pending") candidate.status = approval.status;
      state.runs = [...state.runs, runRecord("send-error", { approvalId: approval.id, username: approval.username, reason })].slice(-200);
      state.updatedAt = new Date().toISOString();
      await writeJson(file, state);
      throw error;
    }
  } finally { await release(); }
}

async function handleSkip(request, args) {
  const release = await acquireRunLock(request.chatId);
  try {
    const name = profileName(args);
    const { stateDir } = await loadProfile(request.chatId, name);
    const { file, state } = await loadState(stateDir, name);
    const approval = pendingApproval(state);
    if (!approval || clean(args.approvalId) !== approval.id) throw new Error("No matching pending approval exists.");
    approval.status = "skipped";
    approval.skippedAt = new Date().toISOString();
    approval.skipReason = clean(args.reason || "user skipped").slice(0, 300);
    const candidate = state.candidates.find((item) => normalizedHandle(item.username) === normalizedHandle(approval.username));
    if (candidate) candidate.status = "skipped";
    state.updatedAt = new Date().toISOString();
    await writeJson(file, state);
    return toolOk({ text: `Skipped approval for @${approval.username}.`, json: { profile: name, approval } });
  } finally { await release(); }
}

async function handleReconcile(request, args) {
  const release = await acquireRunLock(request.chatId);
  try {
    const name = profileName(args);
    const { profile, stateDir } = await loadProfile(request.chatId, name);
    const { file, state } = await loadState(stateDir, name);
    const approval = state.approval;
    if (!approval || approval.id !== clean(args.approvalId)) throw new Error("No matching approval exists for reconciliation.");
    const arisa = createArisaClient({ toolName, chatId: request.chatId });
    const audit = await runTool(arisa, profile.dmTool || "x-dm", { action: "audit", includeHistory: "true" }, 30000);
    const record = audit.history?.sendRecords?.find((item) =>
      item.idempotencyKey === approval.idempotencyKey &&
      item.normalizedUsername === normalizedHandle(approval.username) &&
      item.deliveryVerified === true
    );
    if (!record) throw new Error("No verified matching x-dm history record was found; manual review remains active.");
    approval.status = "sent";
    approval.sentAt = record.sentAt || new Date().toISOString();
    approval.deliveryVerified = true;
    approval.verificationMethod = "x-dm-history-reconciliation";
    if (approval.lastError) approval.priorUncertainError = approval.lastError;
    delete approval.lastError;
    const candidate = state.candidates.find((item) => normalizedHandle(item.username) === normalizedHandle(approval.username));
    if (candidate) {
      candidate.status = "sent";
      candidate.sentAt = approval.sentAt;
      candidate.deliveryVerified = true;
    }
    state.runs = [...state.runs, runRecord("reconcile", { approvalId: approval.id, username: approval.username, deliveryVerified: true })].slice(-200);
    state.updatedAt = new Date().toISOString();
    await writeJson(file, state);
    return toolOk({ text: `Reconciled @${approval.username} as delivered from verified x-dm history.`, json: { profile: name, approval, record } });
  } finally { await release(); }
}

async function handleResolveNotSent(request, args) {
  const release = await acquireRunLock(request.chatId);
  try {
    const name = profileName(args);
    const { profile, stateDir } = await loadProfile(request.chatId, name);
    const { file, state } = await loadState(stateDir, name);
    const approval = state.approval;
    if (!approval || approval.id !== clean(args.approvalId)) throw new Error("No matching approval exists for non-delivery reconciliation.");
    const arisa = createArisaClient({ toolName, chatId: request.chatId });
    const audit = await runTool(arisa, profile.dmTool || "x-dm", { action: "audit", includeHistory: "true" }, 30000);
    const record = audit.history?.attemptRecords?.find((item) =>
      item.idempotencyKey === approval.idempotencyKey &&
      item.normalizedUsername === normalizedHandle(approval.username) &&
      item.outcome === "not-sent"
    );
    if (!record) throw new Error("No matching human-confirmed not-sent x-dm record was found.");
    approval.status = "not-sent";
    approval.resolvedAt = new Date().toISOString();
    approval.verificationMethod = "human-confirmed-not-sent";
    const candidate = state.candidates.find((item) => normalizedHandle(item.username) === normalizedHandle(approval.username));
    if (candidate) {
      candidate.status = "discovered";
      candidate.lastNonDeliveryAt = approval.resolvedAt;
      delete candidate.deliveryVerified;
    }
    state.runs = [...state.runs, runRecord("resolve-not-sent", { approvalId: approval.id, username: approval.username })].slice(-200);
    state.updatedAt = new Date().toISOString();
    await writeJson(file, state);
    return toolOk({ text: `Reconciled @${approval.username} as not sent; the candidate may be prepared again.`, json: { profile: name, approval, record } });
  } finally { await release(); }
}

async function execute(requestFile) {
  const request = JSON.parse((await readFile(requestFile, "utf8")).replace(/^\uFEFF/, ""));
  if (request.chatId == null || request.chatId === "") return toolError("chatId is required.");
  await loadToolConfig(toolName, defaults, request.chatId);
  const args = request.args || {};
  const action = clean(args.action || "status").toLowerCase();
  if (action === "status") return handleStatus(request, args);
  if (action === "discover") return handleDiscover(request, args);
  if (action === "prepare-next") return handlePrepareNext(request, args);
  if (action === "send-approved") return handleSendApproved(request, args);
  if (action === "skip") return handleSkip(request, args);
  if (action === "reconcile") return handleReconcile(request, args);
  if (action === "resolve-not-sent") return handleResolveNotSent(request, args);
  return toolError(`Unknown action: ${action}`);
}

async function main(cliArgs = process.argv.slice(2)) {
  if (!cliArgs.length || cliArgs.includes("--help") || cliArgs[0] === "help") { printHelp(); return; }
  if (cliArgs[0] !== "run") { printHelp(); return; }
  const index = cliArgs.indexOf("--request-file");
  if (!cliArgs[index + 1]) { console.log(JSON.stringify(toolError("--request-file is required."))); return; }
  try { console.log(JSON.stringify(await execute(cliArgs[index + 1]))); }
  catch (error) { console.log(JSON.stringify(toolError(error.message || String(error)))); }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await main();

export { availableCandidates, candidateScore, handleFromXUrl, parseSearchResults, pendingApproval, renderMessage, sha256 };
