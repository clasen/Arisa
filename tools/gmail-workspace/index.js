import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import defaults from "./config.js";
import { acknowledgeSecretaryMessages, normalizeSecretaryState, selectSecretaryWake } from "./secretary-state.js";
import { parseArgvArgument, parseListArgument } from "./arguments.js";

const toolName = "gmail-workspace";

async function getArisaPackageDir() {
  if (process.env.ARISA_PACKAGE_DIR) return process.env.ARISA_PACKAGE_DIR;
  return (await readFile(path.join(os.homedir(), ".arisa", "arisa-package-dir"), "utf8")).trim();
}

async function importCore(relativePath) {
  return import(pathToFileURL(path.join(await getArisaPackageDir(), "src", relativePath)).href);
}

const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");
const { getChatToolStateDir } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`gmail-workspace

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions via args.action:
  auth-help       Show safe OAuth setup options; cookies are not accepted
  auth-status     Run: gws auth status
  list/search     List Gmail message IDs. args: q?, maxResults?, labelIds?, includeSpamTrash?
  list-sent       List sent-message recipients and metadata across pages. args: q?, maxResults?, maxPages?, concurrency?
  list-drafts     List Gmail drafts with recipient, subject, and duplicate-recipient groups. args: maxResults?
  get             Read one message. args: id, format? full|metadata|raw|minimal
  draft           Create a Gmail draft. args: to, subject, body, cc?, bcc?, from?
  reply-draft     Create a draft reply in the same Gmail thread. args: id, body, to?, cc?, bcc?, from?
  update-draft    Replace a Gmail draft. args: id, to, subject, body, cc?, bcc?, from?
  replace-draft-text Safely replace literal text inside draft raw messages. args: ids?, replacements [{from,to}], q?, maxResults?
  replace-draft-subject-text Replace text in decoded draft subjects. args: ids?, replacements [{from,to}], maxResults?
  rewrite-draft-closings Replace final sign-off paragraphs in drafts. args: drafts [{id, closing}]
  insert-draft-intros Add a researched personalized paragraph after a draft greeting. args: drafts [{id, intro}]
  delete-draft    Delete a Gmail draft. args: id
  send            Send email. args: to, subject, body, cc?, bcc?, from?
  reply           Reply in the same Gmail thread. args: id, body, to?, cc?, bcc?, from?, replyAll?
  mark-read       Remove UNREAD label. args: id
  mark-unread     Add UNREAD label. args: id
  archive         Remove INBOX label. args: id
  trash           Move message to trash. args: id
  watch           Start/renew Gmail push watch. args: topicName?, labelIds?
  stop-watch      Stop Gmail push watch
  history         List changes since args.startHistoryId or saved watch historyId
  handle-pubsub   Decode Pub/Sub push payload and list changed message IDs. args: payload?
  poll-secretary  Lease/retry callback for schedulers: wakes agent for matching mail until it is acknowledged, independent of read state; hard-stops threads after two consecutive corrective replies
  secretary-ack   Acknowledge handled or intentionally ignored monitor messages. Use a disposition containing correction when a corrective reply was sent. args: ids, disposition?
  raw             Run an allowed raw gws Gmail command. args.argv: ["gmail","users",...]

List arguments accept native arrays in request files, JSON-encoded arrays through run_tool, and comma-separated strings where applicable.
Authentication uses Google Workspace CLI OAuth/API credentials, not browser cookies.
`);
}

function truthy(value) {
  return value === true || String(value).toLowerCase() === "true";
}

function b64url(input) {
  return Buffer.from(input, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeB64url(input = "") {
  const normalized = String(input).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function headerValue(headers = [], name) {
  return headers.find((h) => String(h.name).toLowerCase() === name.toLowerCase())?.value || "";
}

function extractEmailAddress(value = "") {
  const match = String(value).match(/<([^>]+)>/);
  return (match?.[1] || String(value).split(/[,;]/)[0] || "").trim();
}

function replySubject(subject = "") {
  const text = String(subject || "").trim();
  return /^re:/i.test(text) ? text : `Re: ${text}`;
}

function appendReference(references = "", messageId = "") {
  return [references, messageId].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
}

function extractTextPart(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeB64url(payload.body.data);
  for (const part of payload.parts || []) {
    const found = extractTextPart(part);
    if (found) return found;
  }
  if (payload.body?.data) return decodeB64url(payload.body.data);
  return "";
}

function encodeHeader(value = "") {
  const text = String(value);
  return /[^\x20-\x7e]/.test(text) ? `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=` : text;
}

function makeEmail({ to, subject, body, cc, bcc, from, inReplyTo, references }) {
  if (!to) throw new Error("args.to is required");
  const lines = [];
  if (from) lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${encodeHeader(subject)}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: 8bit");
  lines.push("");
  lines.push(body || "");
  return lines.join("\r\n");
}

function gwsBin() {
  const local = path.join(path.dirname(new URL(import.meta.url).pathname), "node_modules", ".bin", "gws");
  return local;
}

async function refreshAccessToken(token, config) {
  if (!token?.refresh_token || !config.GOOGLE_WORKSPACE_CLI_CONFIG_DIR) return token;
  const clientPath = path.join(config.GOOGLE_WORKSPACE_CLI_CONFIG_DIR, "client_secret.json");
  const client = JSON.parse(await readFile(clientPath, "utf8")).installed;
  const body = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: token.refresh_token,
    grant_type: "refresh_token"
  });
  const response = await fetch(client.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  return { ...token, ...data, refresh_token: token.refresh_token };
}

async function loadSavedToken(request, config) {
  if (config.GOOGLE_WORKSPACE_CLI_TOKEN || !request.chatId) return config;
  const tokenPath = path.join(getChatToolStateDir(String(request.chatId), toolName), "token.json");
  try {
    const token = await refreshAccessToken(JSON.parse(await readFile(tokenPath, "utf8")), config);
    await writeFile(tokenPath, JSON.stringify(token), "utf8");
    return { ...config, GOOGLE_WORKSPACE_CLI_TOKEN: token.access_token };
  } catch {
    return config;
  }
}

async function runCommand(argv, config) {
  const env = { ...process.env };
  for (const key of [
    "GOOGLE_WORKSPACE_CLI_TOKEN",
    "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE",
    "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
    "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET",
    "GOOGLE_WORKSPACE_CLI_CONFIG_DIR",
    "GOOGLE_WORKSPACE_PROJECT_ID"
  ]) {
    if (config[key]) env[key] = String(config[key]);
  }

  const bin = gwsBin();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `gws exited with code ${code}`).trim()));
    });
  });
}

async function gwsJson(argv, config) {
  const { stdout } = await runCommand(argv, config);
  try { return JSON.parse(stdout); }
  catch { return stdout; }
}

async function mapConcurrent(items, concurrency, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, worker));
  return results;
}

function userId(request, config) {
  return String(request.args?.userId || config.GMAIL_DEFAULT_USER_ID || defaults.GMAIL_DEFAULT_USER_ID || "me");
}

function formatList(data) {
  const messages = data.messages || [];
  if (!messages.length) return `No messages found. Estimate: ${data.resultSizeEstimate ?? 0}`;
  return messages.map((m, i) => `${i + 1}. ${m.id} thread:${m.threadId}`).join("\n") + (data.nextPageToken ? `\nnextPageToken: ${data.nextPageToken}` : "");
}

function rawHeader(raw, name) {
  const match = String(raw || "").match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || "";
}

function rawGreeting(raw) {
  const divider = String(raw || "").match(/\r?\n\r?\n([\s\S]*)$/);
  return divider?.[1]?.match(/^\s*([^\r\n]{1,120},)/)?.[1]?.trim() || "";
}

function decodeMimeWords(value = "") {
  return String(value).replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (_, charset, encoding, text) => {
    if (!/^utf-?8$/i.test(charset)) return _;
    if (encoding.toLowerCase() === "b") return Buffer.from(text, "base64").toString("utf8");
    return text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
  });
}

function replaceRawSubject(raw, subject) {
  return String(raw).replace(/^Subject:\s*.*$/im, `Subject: ${encodeHeader(subject)}`);
}

function normalizeReplacements(value) {
  const input = Array.isArray(value) ? value : typeof value === "string" ? JSON.parse(value) : [];
  if (!Array.isArray(input) || !input.length) throw new Error("args.replacements must contain at least one replacement");
  return input.map((item) => {
    const from = String(item.from ?? "");
    const to = String(item.to ?? "");
    if (!from) throw new Error("Each replacement requires a non-empty from value");
    return { from, to };
  });
}

function applyLiteralReplacements(raw, replacements) {
  let next = String(raw || "");
  for (const { from, to } of replacements) {
    next = next.split(from).join(to);
  }
  return next;
}

function rawContainsAll(raw, terms = []) {
  const text = String(raw || "").toLowerCase();
  return terms.every((term) => text.includes(String(term).toLowerCase()));
}

function formatMessage(message) {
  const headers = message.payload?.headers || [];
  const subject = headerValue(headers, "Subject");
  const from = headerValue(headers, "From");
  const date = headerValue(headers, "Date");
  const body = extractTextPart(message.payload).trim();
  return [`Subject: ${subject}`, `From: ${from}`, `Date: ${date}`, `ID: ${message.id}`, "", body || message.snippet || "(no readable text body)"].join("\n");
}

async function statePath(request, name) {
  if (!request.chatId) throw new Error("chatId is required for this action");
  const dir = getChatToolStateDir(String(request.chatId), toolName);
  await mkdir(dir, { recursive: true });
  return path.join(dir, name);
}

async function readJsonSafe(filePath, fallback = {}) {
  try { return JSON.parse(await readFile(filePath, "utf8")); }
  catch { return fallback; }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, filePath);
}

function parseMessageIds(value) {
  return parseListArgument(value);
}


function decodePubsubPayload(value) {
  const payload = typeof value === "string" ? JSON.parse(value) : value;
  const data = payload?.message?.data || payload?.data;
  if (!data) throw new Error("Pub/Sub payload must include message.data");
  return JSON.parse(Buffer.from(String(data), "base64").toString("utf8"));
}

function changedMessageIds(historyData) {
  const seen = new Map();
  for (const item of historyData.history || []) {
    for (const added of item.messagesAdded || []) {
      if (added.message?.id) seen.set(added.message.id, added.message);
    }
  }
  return [...seen.values()];
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "unknown";
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((value % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

async function savedTokenStatus(request) {
  if (!request.chatId) return { exists: false };
  const token = await readJsonSafe(await statePath(request, "token.json"), null);
  if (!token) return { exists: false };
  const refreshSeconds = token.refresh_token_expires_in ? Number(token.refresh_token_expires_in) : null;
  return {
    exists: true,
    hasRefreshToken: Boolean(token.refresh_token),
    accessTokenTtl: formatDuration(token.expires_in),
    refreshTokenTtl: refreshSeconds ? formatDuration(refreshSeconds) : "no fixed expiry reported",
    durable: Boolean(token.refresh_token) && !refreshSeconds,
    note: refreshSeconds ? "This OAuth refresh token has a fixed expiry, usually because the Google OAuth consent app is in Testing mode. Re-authenticate with a Production OAuth app for a durable Gmail session." : "Refresh token has no fixed expiry reported; Google can still revoke it if unused for months, the app is revoked, or the password/security state changes."
  };
}

async function handle(request, config) {
  const action = String(request.args?.action || request.args?.cmd || request.text || "list").trim().toLowerCase();
  const uid = userId(request, config);

  if (action === "auth-help") {
    return { text: "Usa OAuth con Google Workspace CLI. Opciones: 1) configura GOOGLE_WORKSPACE_CLI_TOKEN con un access token OAuth temporal; 2) configura GOOGLE_WORKSPACE_CLI_CLIENT_ID y GOOGLE_WORKSPACE_CLI_CLIENT_SECRET y ejecuta gws auth login en el servidor; 3) apunta GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE a un JSON de credenciales OAuth. No pegues cookies de navegador: son credenciales de sesión sensibles y esta tool no las acepta.", json: { acceptsCookies: false } };
  }

  if (action === "auth-status") {
    const { stdout, stderr } = await runCommand(["auth", "status"], config);
    const tokenStatus = await savedTokenStatus(request);
    let gmailProbe = { ok: false };
    try {
      const probe = await gwsJson(["gmail", "users", "messages", "list", "--params", JSON.stringify({ userId: uid, maxResults: 1 })], config);
      gmailProbe = { ok: true, resultSizeEstimate: probe.resultSizeEstimate ?? null };
    } catch (error) {
      gmailProbe = { ok: false, error: error.message || String(error) };
    }
    const lines = [
      (stdout || stderr).trim(),
      "",
      `Gmail API probe: ${gmailProbe.ok ? "ok" : "failed"}`,
      tokenStatus.exists ? `Saved refresh token: ${tokenStatus.hasRefreshToken ? "yes" : "no"}` : "Saved refresh token: no",
      tokenStatus.exists ? `Access token TTL: ${tokenStatus.accessTokenTtl}` : "",
      tokenStatus.exists ? `Refresh token TTL: ${tokenStatus.refreshTokenTtl}` : "",
      tokenStatus.note || ""
    ].filter(Boolean).join("\n");
    return { text: lines, json: { stdout, stderr, gmailProbe, tokenStatus } };
  }

  if (action === "list" || action === "search") {
    const params = { userId: uid };
    if (request.args?.q) params.q = String(request.args.q);
    if (request.args?.maxResults) params.maxResults = Number(request.args.maxResults);
    if (request.args?.pageToken) params.pageToken = String(request.args.pageToken);
    if (request.args?.labelIds) params.labelIds = Array.isArray(request.args.labelIds) ? request.args.labelIds : String(request.args.labelIds).split(",").map((s) => s.trim()).filter(Boolean);
    if (request.args?.includeSpamTrash !== undefined) params.includeSpamTrash = truthy(request.args.includeSpamTrash);
    const data = await gwsJson(["gmail", "users", "messages", "list", "--params", JSON.stringify(params)], config);
    return { text: formatList(data), json: data };
  }

  if (action === "list-sent") {
    const requestedMaxResults = Number(request.args?.maxResults || 1000);
    const maxResults = Number.isFinite(requestedMaxResults) ? Math.max(1, Math.min(Math.trunc(requestedMaxResults), 5000)) : 1000;
    const maxPages = Math.max(1, Math.min(Number(request.args?.maxPages || 10), 20));
    const query = String(request.args?.q || "in:sent");
    const messages = [];
    let pageToken = request.args?.pageToken ? String(request.args.pageToken) : "";
    for (let page = 0; page < maxPages && messages.length < maxResults; page += 1) {
      const params = { userId: uid, q: query, maxResults: Math.min(500, maxResults - messages.length) };
      if (pageToken) params.pageToken = pageToken;
      const data = await gwsJson(["gmail", "users", "messages", "list", "--params", JSON.stringify(params)], config);
      messages.push(...(data.messages || []));
      pageToken = data.nextPageToken || "";
      if (!pageToken) break;
    }
    const concurrency = Math.max(1, Math.min(Number(request.args?.concurrency || 10), 20));
    const sent = await mapConcurrent(messages, concurrency, async (message) => {
      const current = await gwsJson(["gmail", "users", "messages", "get", "--params", JSON.stringify({
        userId: uid,
        id: String(message.id),
        format: "metadata",
        metadataHeaders: ["To", "Subject", "Date"]
      })], config);
      const headers = current.payload?.headers || [];
      return {
        id: String(current.id || message.id),
        threadId: String(current.threadId || message.threadId || ""),
        to: headerValue(headers, "To").toLowerCase(),
        subject: decodeMimeWords(headerValue(headers, "Subject")),
        date: headerValue(headers, "Date"),
        internalDate: Number(current.internalDate || 0)
      };
    });
    return {
      text: `${sent.length} sent message(s) matched.`,
      json: { query, messages: sent, nextPageToken: pageToken || null, truncated: Boolean(pageToken) }
    };
  }

  if (action === "list-drafts") {
    const draftsList = [];
    let pageToken = request.args?.pageToken ? String(request.args.pageToken) : "";
    const maxPages = Number(request.args?.maxPages || 10);
    for (let page = 0; page < maxPages; page += 1) {
      const params = { userId: uid, maxResults: Number(request.args?.maxResults || 100) };
      if (pageToken) params.pageToken = pageToken;
      const data = await gwsJson(["gmail", "users", "drafts", "list", "--params", JSON.stringify(params)], config);
      draftsList.push(...(data.drafts || []));
      pageToken = data.nextPageToken || "";
      if (!pageToken) break;
    }
    const drafts = [];
    for (const draft of draftsList) {
      const current = await gwsJson(["gmail", "users", "drafts", "get", "--params", JSON.stringify({ userId: uid, id: String(draft.id), format: "raw" })], config);
      const raw = decodeB64url(current.message?.raw || "");
      drafts.push({
        id: String(draft.id),
        messageId: current.message?.id || draft.message?.id || "",
        to: rawHeader(raw, "To").toLowerCase(),
        greeting: rawGreeting(raw),
        subject: rawHeader(raw, "Subject")
      });
    }
    const grouped = new Map();
    for (const draft of drafts) {
      if (!draft.to) continue;
      grouped.set(draft.to, [...(grouped.get(draft.to) || []), draft]);
    }
    const duplicates = [...grouped.entries()]
      .filter(([, entries]) => entries.length > 1)
      .map(([to, entries]) => ({ to, drafts: entries }));
    return { text: `${drafts.length} draft(s). ${duplicates.length} duplicate recipient group(s).`, json: { drafts, duplicates } };
  }

  if (action === "replace-draft-subject-dash") {
    const data = await gwsJson(["gmail", "users", "drafts", "list", "--params", JSON.stringify({ userId: uid, maxResults: Number(request.args?.maxResults || 100) })], config);
    const updated = [];
    const unchanged = [];
    for (const draft of data.drafts || []) {
      const id = String(draft.id);
      const current = await gwsJson(["gmail", "users", "drafts", "get", "--params", JSON.stringify({ userId: uid, id, format: "raw" })], config);
      const raw = decodeB64url(current.message?.raw || "");
      const subjectHeader = rawHeader(raw, "Subject");
      const subject = decodeMimeWords(subjectHeader);
      if (!subject.includes("–")) {
        unchanged.push({ id, subject });
        continue;
      }
      const nextSubject = subject.replace(/\s*–\s*/g, ": ");
      const rewritten = replaceRawSubject(raw, nextSubject);
      const result = await gwsJson(["gmail", "users", "drafts", "update", "--params", JSON.stringify({ userId: uid, id }), "--json", JSON.stringify({ id, message: { raw: b64url(rewritten) } })], config);
      updated.push({ id: result.id || id, subject: nextSubject });
    }
    return { text: `Updated ${updated.length} draft subject(s). ${unchanged.length} unchanged.`, json: { updated, unchanged } };
  }

  if (action === "replace-draft-text") {
    const replacements = normalizeReplacements(request.args?.replacements);
    const ids = parseListArgument(request.args?.ids);
    const onlyIfContains = Array.isArray(request.args?.onlyIfContains)
      ? request.args.onlyIfContains
      : String(request.args?.onlyIfContains || "").split("||").map((s) => s.trim()).filter(Boolean);
    const targetIds = [];
    if (ids.length) {
      targetIds.push(...ids);
    } else {
      const params = { userId: uid, maxResults: Number(request.args?.maxResults || 150) };
      const data = await gwsJson(["gmail", "users", "drafts", "list", "--params", JSON.stringify(params)], config);
      targetIds.push(...(data.drafts || []).map((draft) => String(draft.id)));
    }
    const updated = [];
    const unchanged = [];
    for (const id of targetIds) {
      const current = await gwsJson(["gmail", "users", "drafts", "get", "--params", JSON.stringify({ userId: uid, id, format: "raw" })], config);
      const raw = decodeB64url(current.message?.raw || "");
      if (onlyIfContains.length && !rawContainsAll(raw, onlyIfContains)) {
        unchanged.push({ id, reason: "filter_not_matched", to: rawHeader(raw, "To"), subject: rawHeader(raw, "Subject") });
        continue;
      }
      const rewritten = applyLiteralReplacements(raw, replacements);
      if (rewritten === raw) {
        unchanged.push({ id, reason: "no_match", to: rawHeader(raw, "To"), subject: rawHeader(raw, "Subject") });
        continue;
      }
      const result = await gwsJson(["gmail", "users", "drafts", "update", "--params", JSON.stringify({ userId: uid, id }), "--json", JSON.stringify({ id, message: { raw: b64url(rewritten) } })], config);
      updated.push({ id: result.id || id, to: rawHeader(rewritten, "To"), subject: rawHeader(rewritten, "Subject") });
    }
    return { text: `Updated ${updated.length} draft(s). ${unchanged.length} unchanged.`, json: { updated, unchanged } };
  }

  if (action === "replace-draft-subject-text") {
    const replacements = normalizeReplacements(request.args?.replacements);
    const ids = parseListArgument(request.args?.ids);
    const targetIds = [];
    if (ids.length) {
      targetIds.push(...ids);
    } else {
      const data = await gwsJson(["gmail", "users", "drafts", "list", "--params", JSON.stringify({ userId: uid, maxResults: Number(request.args?.maxResults || 150) })], config);
      targetIds.push(...(data.drafts || []).map((draft) => String(draft.id)));
    }
    const updated = [];
    const unchanged = [];
    for (const id of targetIds) {
      const current = await gwsJson(["gmail", "users", "drafts", "get", "--params", JSON.stringify({ userId: uid, id, format: "raw" })], config);
      const raw = decodeB64url(current.message?.raw || "");
      const subjectHeader = rawHeader(raw, "Subject");
      const subject = decodeMimeWords(subjectHeader);
      const nextSubject = applyLiteralReplacements(subject, replacements);
      if (nextSubject === subject) {
        unchanged.push({ id, reason: "no_match", subject });
        continue;
      }
      const rewritten = replaceRawSubject(raw, nextSubject);
      const result = await gwsJson(["gmail", "users", "drafts", "update", "--params", JSON.stringify({ userId: uid, id }), "--json", JSON.stringify({ id, message: { raw: b64url(rewritten) } })], config);
      updated.push({ id: result.id || id, to: rawHeader(rewritten, "To"), subject: nextSubject });
    }
    return { text: `Updated ${updated.length} draft subject(s). ${unchanged.length} unchanged.`, json: { updated, unchanged } };
  }

  if (action === "get") {
    const id = request.args?.id || request.args?.messageId;
    if (!id) throw new Error("args.id is required");
    const params = { userId: uid, id: String(id), format: request.args?.format || "full" };
    const data = await gwsJson(["gmail", "users", "messages", "get", "--params", JSON.stringify(params)], config);
    return { text: formatMessage(data), json: data };
  }

  if (action === "draft") {
    const raw = b64url(makeEmail(request.args || {}));
    const data = await gwsJson(["gmail", "users", "drafts", "create", "--params", JSON.stringify({ userId: uid }), "--json", JSON.stringify({ message: { raw } })], config);
    return { text: `Draft created. Draft ID: ${data.id || "unknown"}`, json: data };
  }

  if (action === "reply-draft") {
    const id = request.args?.id || request.args?.messageId;
    if (!id) throw new Error("args.id is required");
    const original = await gwsJson(["gmail", "users", "messages", "get", "--params", JSON.stringify({ userId: uid, id: String(id), format: "metadata" })], config);
    const headers = original.payload?.headers || [];
    const messageId = headerValue(headers, "Message-ID");
    const raw = b64url(makeEmail({
      ...request.args,
      to: request.args?.to || extractEmailAddress(headerValue(headers, "From")),
      cc: request.args?.cc || (truthy(request.args?.replyAll) ? headerValue(headers, "Cc") : ""),
      subject: request.args?.subject || replySubject(headerValue(headers, "Subject")),
      inReplyTo: messageId,
      references: appendReference(headerValue(headers, "References"), messageId)
    }));
    const data = await gwsJson(["gmail", "users", "drafts", "create", "--params", JSON.stringify({ userId: uid }), "--json", JSON.stringify({ message: { raw, threadId: original.threadId } })], config);
    return { text: `Reply draft created. Draft ID: ${data.id || "unknown"}`, json: data };
  }

  if (action === "update-draft") {
    const id = request.args?.id || request.args?.draftId;
    if (!id) throw new Error("args.id is required");
    const raw = b64url(makeEmail(request.args || {}));
    const data = await gwsJson(["gmail", "users", "drafts", "update", "--params", JSON.stringify({ userId: uid, id: String(id) }), "--json", JSON.stringify({ id: String(id), message: { raw } })], config);
    return { text: `Draft updated. Draft ID: ${data.id || id}`, json: data };
  }

  if (action === "rewrite-draft-closings") {
    const draftInput = request.args?.drafts;
    const drafts = Array.isArray(draftInput) ? draftInput : typeof draftInput === "string" ? JSON.parse(draftInput) : [];
    if (!Array.isArray(drafts) || !drafts.length) throw new Error("args.drafts must contain at least one draft");
    const updated = [];
    for (const draft of drafts) {
      const id = String(draft.id || "");
      const closing = String(draft.closing || "").trim();
      if (!id || !closing) throw new Error("Each draft requires id and closing");
      const current = await gwsJson(["gmail", "users", "drafts", "get", "--params", JSON.stringify({ userId: uid, id, format: "raw" })], config);
      const raw = decodeB64url(current.message?.raw || "");
      const divider = raw.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
      const boundary = raw.indexOf(divider);
      if (boundary < 0) throw new Error(`Draft ${id} has no message body`);
      const headers = raw.slice(0, boundary);
      const body = raw.slice(boundary + divider.length);
      const signoff = body.match(/\r?\n\r?\n(Best,|Saludos,)\r?\nArisa\s*$/);
      if (!signoff || signoff.index === undefined) throw new Error(`Draft ${id} has no Arisa sign-off`);
      const beforeSignoff = body.slice(0, signoff.index);
      const paragraphStart = Math.max(beforeSignoff.lastIndexOf("\n\n"), beforeSignoff.lastIndexOf("\r\n\r\n"));
      const prefix = paragraphStart < 0 ? "" : beforeSignoff.slice(0, paragraphStart + (beforeSignoff.includes("\r\n") ? 4 : 2));
      const rewritten = `${headers}${divider}${prefix}${closing}${signoff[0]}`;
      const data = await gwsJson(["gmail", "users", "drafts", "update", "--params", JSON.stringify({ userId: uid, id }), "--json", JSON.stringify({ id, message: { raw: b64url(rewritten) } })], config);
      updated.push({ id: data.id || id });
    }
    return { text: `Updated ${updated.length} draft closing(s).`, json: { updated } };
  }

  if (action === "insert-draft-intros") {
    const input = request.args?.drafts;
    const drafts = Array.isArray(input) ? input : typeof input === "string" ? JSON.parse(input) : [];
    if (!Array.isArray(drafts) || !drafts.length) throw new Error("args.drafts must contain draft ids and intros");
    const updated = [];
    const failed = [];
    for (const draft of drafts) {
      const id = String(draft.id || "");
      const intro = String(draft.intro || "").trim();
      try {
        if (!id || !intro) throw new Error("Each draft requires id and intro");
        const current = await gwsJson(["gmail", "users", "drafts", "get", "--params", JSON.stringify({ userId: uid, id, format: "raw" })], config);
        const raw = decodeB64url(current.message?.raw || "");
        const match = raw.match(/((?:Hi|Hola|Hallo|Bonjour|Ciao)\s+[^\r\n,]+,\r?\n\r?\n|(?:안녕하세요|こんにちは|你好)[^\r\n]*(?:,|，|、)\r?\n\r?\n)/);
        if (!match) throw new Error("Draft has no recognizable greeting");
        const rewritten = raw.replace(match[1], `${match[1]}${intro}\r\n\r\n`);
        const data = await gwsJson(["gmail", "users", "drafts", "update", "--params", JSON.stringify({ userId: uid, id }), "--json", JSON.stringify({ id, message: { raw: b64url(rewritten) } })], config);
        updated.push(data.id || id);
      } catch (error) {
        failed.push({ id, error: error.message || String(error) });
      }
    }
    return { text: `Added personalized intros to ${updated.length} draft(s).${failed.length ? ` ${failed.length} draft(s) need review.` : ""}`, json: { updated, failed } };
  }

  if (action === "delete-draft") {
    const id = request.args?.id || request.args?.draftId;
    if (!id) throw new Error("args.id is required");
    await gwsJson(["gmail", "users", "drafts", "delete", "--params", JSON.stringify({ userId: uid, id: String(id) })], config);
    return { text: `Draft deleted: ${id}`, json: { id: String(id) } };
  }

  if (action === "send") {
    const raw = b64url(makeEmail(request.args || {}));
    const data = await gwsJson(["gmail", "users", "messages", "send", "--params", JSON.stringify({ userId: uid }), "--json", JSON.stringify({ raw })], config);
    return { text: `Email sent. Message ID: ${data.id || "unknown"}`, json: data };
  }

  if (action === "reply") {
    const id = request.args?.id || request.args?.messageId;
    if (!id) throw new Error("args.id is required");
    const original = await gwsJson(["gmail", "users", "messages", "get", "--params", JSON.stringify({ userId: uid, id: String(id), format: "metadata" })], config);
    const headers = original.payload?.headers || [];
    const messageId = headerValue(headers, "Message-ID");
    const raw = b64url(makeEmail({
      ...request.args,
      to: request.args?.to || extractEmailAddress(headerValue(headers, "From")),
      cc: request.args?.cc || (truthy(request.args?.replyAll) ? headerValue(headers, "Cc") : ""),
      subject: request.args?.subject || replySubject(headerValue(headers, "Subject")),
      inReplyTo: messageId,
      references: appendReference(headerValue(headers, "References"), messageId)
    }));
    const data = await gwsJson(["gmail", "users", "messages", "send", "--params", JSON.stringify({ userId: uid }), "--json", JSON.stringify({ raw, threadId: original.threadId })], config);
    return { text: `Reply sent. Message ID: ${data.id || "unknown"}`, json: data };
  }

  if (["mark-read", "mark-unread", "archive"].includes(action)) {
    const id = request.args?.id || request.args?.messageId;
    if (!id) throw new Error("args.id is required");
    const body = action === "mark-read" ? { removeLabelIds: ["UNREAD"] } : action === "mark-unread" ? { addLabelIds: ["UNREAD"] } : { removeLabelIds: ["INBOX"] };
    const data = await gwsJson(["gmail", "users", "messages", "modify", "--params", JSON.stringify({ userId: uid, id: String(id) }), "--json", JSON.stringify(body)], config);
    return { text: `${action} done for ${id}`, json: data };
  }

  if (action === "trash") {
    const id = request.args?.id || request.args?.messageId;
    if (!id) throw new Error("args.id is required");
    const data = await gwsJson(["gmail", "users", "messages", "trash", "--params", JSON.stringify({ userId: uid, id: String(id) })], config);
    return { text: `Moved to trash: ${id}`, json: data };
  }

  if (action === "watch") {
    const topicName = request.args?.topicName || config.GMAIL_PUBSUB_TOPIC;
    if (!topicName) throw new Error("args.topicName or config GMAIL_PUBSUB_TOPIC is required");
    const labelIds = request.args?.labelIds ? (Array.isArray(request.args.labelIds) ? request.args.labelIds : String(request.args.labelIds).split(",").map((s) => s.trim()).filter(Boolean)) : ["INBOX"];
    const body = { topicName: String(topicName), labelIds };
    if (request.args?.labelFilterBehavior) body.labelFilterBehavior = String(request.args.labelFilterBehavior);
    const data = await gwsJson(["gmail", "users", "watch", "--params", JSON.stringify({ userId: uid }), "--json", JSON.stringify(body)], config);
    await writeFile(await statePath(request, "watch.json"), JSON.stringify({ ...data, topicName, labelIds, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    return { text: `Gmail watch active. historyId: ${data.historyId}, expires: ${data.expiration}`, json: data };
  }

  if (action === "stop-watch") {
    const data = await gwsJson(["gmail", "users", "stop", "--params", JSON.stringify({ userId: uid })], config);
    return { text: "Gmail watch stopped.", json: data };
  }

  if (action === "history") {
    const saved = await readJsonSafe(await statePath(request, "watch.json"), {});
    const startHistoryId = request.args?.startHistoryId || saved.historyId;
    if (!startHistoryId) throw new Error("args.startHistoryId or saved watch historyId is required");
    const params = { userId: uid, startHistoryId: String(startHistoryId), historyTypes: ["messageAdded"], maxResults: Number(request.args?.maxResults || 100) };
    if (request.args?.labelId !== "") params.labelId = request.args?.labelId || "INBOX";
    const data = await gwsJson(["gmail", "users", "history", "list", "--params", JSON.stringify(params)], config);
    const messages = changedMessageIds(data);
    if (data.historyId) await writeFile(await statePath(request, "watch.json"), JSON.stringify({ ...saved, historyId: data.historyId, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    return { text: messages.length ? formatList({ messages }) : "No new messageAdded changes.", json: { ...data, changedMessages: messages } };
  }

  if (action === "handle-pubsub") {
    const notification = decodePubsubPayload(request.args?.payload || request.args?.pubsub || request.artifact?.text || request.text);
    const saved = await readJsonSafe(await statePath(request, "watch.json"), {});
    const startHistoryId = saved.historyId || request.args?.startHistoryId || notification.historyId;
    const params = { userId: uid, startHistoryId: String(startHistoryId), historyTypes: ["messageAdded"], labelId: "INBOX", maxResults: Number(request.args?.maxResults || 100) };
    const data = await gwsJson(["gmail", "users", "history", "list", "--params", JSON.stringify(params)], config);
    const messages = changedMessageIds(data);
    if (data.historyId) await writeFile(await statePath(request, "watch.json"), JSON.stringify({ ...saved, historyId: data.historyId, lastNotification: notification, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    return { text: messages.length ? formatList({ messages }) : "Push received; no new INBOX messageAdded changes.", json: { notification, history: data, changedMessages: messages } };
  }

  if (action === "secretary-ack") {
    const ids = parseMessageIds(request.args?.ids || request.args?.messageIds || request.args?.id);
    if (!ids.length) throw new Error("args.ids is required");
    const monitorPath = await statePath(request, "secretary-state.json");
    const current = normalizeSecretaryState(await readJsonSafe(monitorPath, {}));
    const result = acknowledgeSecretaryMessages(current, ids, request.args?.disposition || "handled");
    await writeJsonAtomic(monitorPath, result.state);
    return {
      text: `Acknowledged ${result.acknowledged.length} secretary message(s).`,
      json: { acknowledged: result.acknowledged, count: result.acknowledged.length }
    };
  }

  if (action === "poll-secretary") {
    const monitorPath = await statePath(request, "secretary-state.json");
    const current = normalizeSecretaryState(await readJsonSafe(monitorPath, {}));
    const query = request.args?.q || "in:inbox newer_than:7d";
    const requestedMaxResults = Number(request.args?.maxResults || 500);
    const maxResults = Number.isFinite(requestedMaxResults) ? Math.max(1, Math.min(Math.trunc(requestedMaxResults), 500)) : 500;
    const data = await gwsJson(["gmail", "users", "messages", "list", "--params", JSON.stringify({ userId: uid, q: query, maxResults })], config);
    const selection = selectSecretaryWake(data.messages || [], current, {
      retrySeconds: Number(request.args?.retrySeconds || 600),
      maxWake: Number(request.args?.maxWake || 20),
      correctionGateThreshold: Number(request.args?.correctionGateThreshold || 2)
    });
    await writeJsonAtomic(monitorPath, selection.state);
    if (!selection.selected.length) {
      return { text: "No wake: no due unacknowledged matching messages.", json: { shouldWakeAgent: false, query, matched: (data.messages || []).length, checkedAt: new Date().toISOString() } };
    }

    const ids = selection.selected.map((message) => message.id);
    const blockedIds = selection.selected.filter((message) => message.correctionGate?.blocked).map((message) => message.id);
    const correctionStop = blockedIds.length
      ? `\n\nHard stop for message IDs ${blockedIds.join(", ")}: each thread already has at least two consecutive corrective replies. Read the message and inspect the thread, but do not send another external reply. Alert the user with a concise summary, wait for guidance, and acknowledge each exact ID with disposition actionable-thread-escalation-awaiting-user.`
      : "";
    const basePrompt = request.args?.wakePrompt || "Review the exact Gmail messages listed below as the user's secretary. Read every message by id, handle genuine replies, classify bounces, and ignore unrelated mail safely.";
    const prompt = `${basePrompt}

Exact Gmail message IDs for this wake: ${ids.join(", ")}. Read every ID even if Gmail already marks it read. Before replying, inspect the thread for a later outgoing answer so a retry never creates a duplicate. When a corrective reply is sent, use a secretary-ack disposition containing correction so the thread safety gate remains deterministic. After each message is replied to, recorded as a bounce, found already answered, intentionally ignored, or escalated to the user, call gmail-workspace action secretary-ack with that exact ID and a disposition. If this agent run fails before acknowledgement, the monitor will retry after its lease expires.${correctionStop}`;
    return {
      text: `Wake agent: ${ids.length} due matching message(s).`,
      json: { shouldWakeAgent: true, query, messages: selection.selected },
      asyncTask: { kind: "agent_task", runAt: new Date().toISOString(), payload: { prompt } }
    };
  }

  if (action === "raw") {
    const argv = parseArgvArgument(request.args?.argv);
    const { stdout, stderr } = await runCommand(argv, config);
    return { text: (stdout || stderr).trim(), json: { stdout, stderr } };
  }

  throw new Error(`Unknown action: ${action}`);
}

async function run(requestFile) {
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    const config = await loadSavedToken(request, await loadToolConfig(toolName, defaults, request.chatId));
    const result = await handle(request, config);
    const extra = {};
    if (result.asyncTask) extra.asyncTask = result.asyncTask;
    if (result.asyncTasks) extra.asyncTasks = result.asyncTasks;
    console.log(JSON.stringify(toolOk({ text: result.text, json: result.json }, extra)));
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
  }
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
else if (args[0] === "run") await run(args[args.indexOf("--request-file") + 1]);
else printHelp();
