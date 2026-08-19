import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import pkg from "whatsapp-web.js";
import defaults from "./config.js";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");
const { ArtifactStore } = await importCore("core/artifacts/artifact-store.js");
const { createDaemonRuntime } = await importCore("core/tools/daemon-runtime.js");
const { createArisaClient } = await importCore("core/tools/ipc-client.js");
const {
  daemonPaths,
  isProcessAlive,
  readDaemonLaunchContext,
  readJson,
  registerManagedDaemon,
  stopManagedDaemon,
  writeJson
} = await importCore("core/tools/daemon-processes.js");
const { getChatToolStateDir, getToolStateDir, tasksFile } = await importCore("runtime/paths.js");

const require = createRequire(import.meta.url);
const WebP = require("node-webpmux");

const { Client, LocalAuth, MessageMedia } = pkg;
const toolName = "whatsapp-web";
const entryPath = fileURLToPath(import.meta.url);
const legacyRoot = getToolStateDir(toolName);
const legacySessionDir = path.join(legacyRoot, "session");
const legacyChatSessionsRoot = path.join(legacyRoot, "chats");
const artifactStore = new ArtifactStore();
let config = defaults;

async function cleanupLegacyGlobalDaemon() {
  const paths = daemonPaths(toolName);
  const { pid } = await readJson(paths.pidFile, {});
  if (isProcessAlive(pid) && pid !== process.pid) {
    await stopManagedDaemon(toolName);
  }
}

function daemonForChat(chatId, { autoStart = true } = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  return createDaemonRuntime({
    toolName,
    entryPath,
    scope: { type: "chat", chatId: normalizedChatId },
    startupContext: { chatId: normalizedChatId },
    autoStart,
    beforeStart: async () => {
      await cleanupLegacyGlobalDaemon();
      await cleanupBrowserLocks(chatPaths(normalizedChatId));
    }
  });
}

async function useChatConfig(chatId) {
  config = await loadToolConfig(toolName, defaults, normalizeChatId(chatId));
  return config;
}

function printHelp() {
  console.log(`whatsapp-web

Usage:
  node index.js --help
  node index.js run --request-file <json>

Modes:
  login      Start this chat's WhatsApp session, enable watch, and return a QR code when needed.
  status     Show this chat's WhatsApp session status.
  send       Send one WhatsApp message from this chat's WhatsApp session. Enables watch by default. Supports humanized delay/typing.
  set-profile-picture Set the current WhatsApp account profile picture from an image artifact. Optional args.zoom, focusX, and focusY crop it closer.
  broadcast  Send one message to multiple recipients from this chat's session. Enables watch by default. Supports humanized delay/typing.
  inbox      Read/process received WhatsApp replies from this chat's local inbox.
  sync       Backfill recent messages from known chats/groups into the inbox.
  wait-reply Wait for a reply from an optional recipient after sending.
  react      React to a WhatsApp message by id, or the latest inbox message.
  reactions  Show reactions for a WhatsApp message by id, or the latest inbox message.
  delete     Delete a recent sent WhatsApp message by id or recent-match filter.
  stickers   List, tag, and send saved stickers from this chat.
  watch      Keep this chat's WhatsApp session live and process incoming messages.
  unwatch    Disable event-driven processing for this chat.
  qr         Generate a PNG image from this chat's latest login QR.
  logout     Stop and remove only this chat's local WhatsApp session.

Examples:
  { "chatId": "123456789", "args": { "mode": "login" } }
  { "chatId": "123456789", "args": { "mode": "send", "to": "+15551234567", "message": "Hello" } }
  { "chatId": "123456789", "args": { "mode": "send", "to": "+15551234567", "message": "Hello", "initialDelayMs": "10000", "typingMs": "30000" } }
  { "chatId": "123456789", "args": { "mode": "send", "to": "+15551234567", "message": "Replying", "quotedMessageId": "..." } }
  { "chatId": "123456789", "artifact": { "path": "/tmp/avatar.jpg" }, "args": { "mode": "set-profile-picture", "zoom": "2", "focusX": "0.55", "focusY": "0.08" } }
  { "chatId": "123456789", "args": { "mode": "wait-reply", "from": "+15551234567" } }
  { "chatId": "123456789", "args": { "mode": "react", "messageId": "...", "emoji": "👀" } }
  { "chatId": "123456789", "args": { "mode": "reactions", "messageId": "..." } }
  { "chatId": "123456789", "args": { "mode": "delete", "to": "+15551234567", "text": "caption/text to match" } }
  { "chatId": "123456789", "args": { "mode": "watch" } }

Recommended workflow:
  login once -> keep watch enabled -> send -> wait-reply when the agent needs the immediate answer.
  If WhatsApp is active, watch should stay enabled so replies are processed automatically.

Per-chat sessions: ${getChatToolStateDir("<chatId>", toolName)}/session
Legacy global sessions ignored: ${legacySessionDir} and ${legacyChatSessionsRoot}

Warning: use a dedicated auxiliary number for the bot; WhatsApp Web automation can put accounts at risk of Meta restrictions or bans.
`);
}

function bool(value, fallback = true) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  return fallback;
}

function number(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedNumber(value, fallback, min, max) {
  return Math.min(max, Math.max(min, number(value, fallback)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withOperationTimeout(work, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeChatId(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("chatId is required for whatsapp-web");
  if (!/^-?\d+$/.test(text)) throw new Error(`Invalid chatId: ${text}`);
  return text;
}

function requestChatId(request) {
  return normalizeChatId(request.chatId || request.args?.chatId || request.args?.telegramChatId || request.artifact?.chatId);
}

function chatPaths(chatId) {
  const root = getChatToolStateDir(normalizeChatId(chatId), toolName);
  return {
    root,
    sessionDir: path.join(root, "session"),
    statusFile: path.join(root, "status.json"),
    qrImageFile: path.join(root, "whatsapp-login-qr.png"),
    mediaTmpDir: path.join(root, "media-tmp"),
    webCacheDir: path.join(root, "web-cache"),
    lockFile: path.join(root, "lock")
  };
}

async function ensureChatState(paths) {
  await mkdir(paths.root, { recursive: true });
}

async function readChatStatus(chatId, fallback = {}) {
  return readJson(chatPaths(chatId).statusFile, fallback);
}

async function writeChatStatus(chatId, patch) {
  const paths = chatPaths(chatId);
  const current = await readJson(paths.statusFile, {});
  const next = { ...current, ...patch, chatId: normalizeChatId(chatId), updatedAt: new Date().toISOString() };
  if (patch.state && patch.state !== "needs_login") {
    delete next.qr;
    delete next.qrText;
  }
  await writeJson(paths.statusFile, next);
  return next;
}

function statusText(chatId, status, pid) {
  return [
    `WhatsApp status for chat ${chatId}: ${status.state || "unknown"}`,
    status.message || "",
    typeof status.live === "boolean" ? `Live client: ${status.live ? "yes" : "no"}` : "",
    pid ? `Daemon pid: ${pid}` : ""
  ].filter(Boolean).join("\n");
}

async function effectiveChatStatus(chatId, fallback = {}) {
  const status = await readChatStatus(chatId, fallback);
  const pid = await daemonForChat(chatId).getPid();
  const alive = isProcessAlive(pid);
  if (status.live && !alive) {
    const repaired = await writeChatStatus(chatId, {
      state: "reconnecting",
      live: false,
      pid: pid || null,
      message: "WhatsApp daemon was stale; it will reconnect on demand."
    });
    return { status: repaired, pid, alive, stale: true };
  }
  return { status, pid, alive, stale: false };
}

async function waitForChatState(chatId, states, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await readChatStatus(chatId, {});
    if (states.includes(status.state)) return status;
    await sleep(500);
  }
  return readChatStatus(chatId, { state: "connecting" });
}

async function waitForLoginSignal(chatId, timeoutMs) {
  return waitForChatState(chatId, ["ready", "needs_login", "expired", "failed"], timeoutMs);
}

async function submitChatJob(chatId, payload, {
  timeoutMs = 180000,
  readyTimeoutMs,
  requireReady = true
} = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  const runtime = daemonForChat(normalizedChatId, {
    autoStart: await isWatchEnabled(normalizedChatId)
  });
  return runtime.submit({
    chatId: normalizedChatId,
    payload
  }, {
    timeoutMs,
    readyTimeoutMs,
    requireReady
  });
}

async function withChatLock(paths, work, { timeoutMs = 30000, staleMs = 120000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await writeFile(paths.lockFile, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { flag: "wx" });
      try {
        return await work();
      } finally {
        await unlink(paths.lockFile).catch(() => {});
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stats = await stat(paths.lockFile).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > staleMs) {
        await rm(paths.lockFile, { force: true }).catch(() => {});
      }
      await sleep(200);
    }
  }
  throw new Error(`Timed out waiting for WhatsApp session lock at ${paths.lockFile}`);
}

async function execFileQuiet(command, args) {
  await new Promise((resolve) => {
    execFile(command, args, () => resolve());
  });
}

async function killChatBrowserProcesses(paths) {
  const userDataDir = path.join(paths.sessionDir, "session");
  await execFileQuiet("pkill", ["-9", "-f", userDataDir]);
}

async function cleanupBrowserLocks(paths) {
  await killChatBrowserProcesses(paths);
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    await rm(path.join(paths.sessionDir, "session", name), { force: true }).catch(() => {});
  }
}

async function readArray(file) {
  const value = await readJson(file, []);
  return Array.isArray(value) ? value : [];
}

function inboxFileForChat(chatId) {
  return path.join(getChatToolStateDir(chatId, toolName), "inbox.json");
}

async function readInbox(chatId) {
  return readArray(inboxFileForChat(chatId));
}

async function writeInbox(chatId, messages) {
  await writeJson(inboxFileForChat(chatId), messages.slice(-1000));
}

async function appendInboxMessage(chatId, message) {
  const messages = await readInbox(chatId);
  if (messages.some((item) => item.id === message.id)) return false;
  messages.push(message);
  await writeInbox(chatId, messages);
  return true;
}

async function updateInboxMessages(chatId, updater) {
  await writeInbox(chatId, updater(await readInbox(chatId)));
}

function compact(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function locationFromMessage(message) {
  if (String(message.type || "").toLowerCase() !== "location") return null;
  const source = message.location || message._data || {};
  const latitude = numberOrNull(source.latitude ?? source.lat ?? source.degreesLatitude);
  const longitude = numberOrNull(source.longitude ?? source.lng ?? source.degreesLongitude);
  const description = compact(source.description || source.loc || source.name || source.address || "");
  if (latitude == null || longitude == null) return description ? { description } : null;
  return {
    latitude,
    longitude,
    description,
    mapsUrl: `https://maps.google.com/?q=${encodeURIComponent(`${latitude},${longitude}`)}`
  };
}

function messageBodyForInbox(message) {
  const location = locationFromMessage(message);
  if (location?.mapsUrl) return location.description ? `${location.description}\n${location.mapsUrl}` : location.mapsUrl;
  if (location?.description) return location.description;
  return message.body || "";
}

function normalizeRecipient(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Recipient is required");
  if (/@(c|g)\.us$/.test(raw) || /@lid$/.test(raw)) return raw;
  let digits = raw.replace(/\D/g, "");
  if (!digits) throw new Error(`Invalid recipient: ${raw}`);
  if (!raw.startsWith("+") && config.DEFAULT_COUNTRY_CODE && !digits.startsWith(config.DEFAULT_COUNTRY_CODE)) {
    digits = `${config.DEFAULT_COUNTRY_CODE}${digits}`;
  }
  return `${digits}@c.us`;
}

function displayTextForInboxItem(item) {
  if (item.location?.mapsUrl) return "";
  if (String(item.type || "").toLowerCase() === "location") return item.body && item.body.length < 300 ? item.body : "[location message; coordinates were not captured by this older inbox entry]";
  return item.body || "[non-text message]";
}

function formatReactions(reactions = []) {
  if (!Array.isArray(reactions) || !reactions.length) return "";
  return reactions.map((item) => `${item.emoji || item.reaction || "?"}${item.senderId ? ` ${item.senderId}` : ""}`).join(", ");
}

function formatInboxMessages(messages) {
  if (!messages.length) return "No WhatsApp replies found.";
  return messages.map((item, index) => [
    `${index + 1}. From: ${item.fromName || item.from}`,
    item.fromPhone ? `Phone: ${item.fromPhone}` : null,
    item.chatName ? `Chat: ${item.chatName}` : null,
    item.isGroup ? `Group: yes` : null,
    item.senderId && item.senderId !== item.from ? `SenderId: ${item.senderId}` : null,
    `At: ${item.receivedAt}`,
    item.type ? `Type: ${item.type}` : null,
    item.location?.mapsUrl ? `Location: ${item.location.mapsUrl}` : null,
    item.location?.description ? `Description: ${item.location.description}` : null,
    formatReactions(item.reactions) ? `Reactions: ${formatReactions(item.reactions)}` : null,
    displayTextForInboxItem(item) ? `Text: ${displayTextForInboxItem(item)}` : null
  ].filter(Boolean).join("\n")).join("\n\n");
}

function matchesInboxFilter(item, { from, unreadOnly, after }) {
  const normalizedFrom = from ? normalizeRecipient(from) : "";
  if (normalizedFrom && item.from !== normalizedFrom) return false;
  if (unreadOnly && item.read) return false;
  if (after && new Date(item.receivedAt).getTime() <= new Date(after).getTime()) return false;
  return true;
}

async function selectInboxMessages({ chatId, from, limit = 20, unreadOnly = false, after = "" }) {
  return (await readInbox(chatId)).filter((item) => matchesInboxFilter(item, { from, unreadOnly, after })).slice(-limit);
}

async function latestInboxMessageId({ chatId, from = "", after = "" }) {
  const messages = await selectInboxMessages({ chatId, from, limit: 1, unreadOnly: false, after });
  return messages[0]?.id || "";
}

async function markMessagesRead(chatId, ids) {
  if (!ids.length) return;
  await updateInboxMessages(chatId, (messages) => messages.map((item) => ids.includes(item.id) ? { ...item, read: true } : item));
}

async function updateInboxMessageReactions(chatId, messageId, reactions) {
  if (!messageId) return;
  await updateInboxMessages(chatId, (messages) => messages.map((item) => item.id === messageId ? { ...item, reactions } : item));
}

async function knownWhatsAppChatIds(ownerChatId) {
  const ids = new Set();
  for (const item of await readInbox(ownerChatId)) {
    const id = item.chatId || item.from;
    if (/@(c|g)\.us$/.test(String(id)) || /@lid$/.test(String(id))) ids.add(id);
  }
  return [...ids];
}

async function waitForInboxMessage({ chatId, from, unreadOnly = true, after = new Date().toISOString(), timeoutMs = 60000 }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const matches = await selectInboxMessages({ chatId, from, limit: 1, unreadOnly, after });
    if (matches.length) return matches[0];
    await sleep(1000);
  }
  throw new Error(`No WhatsApp reply received within ${timeoutMs}ms`);
}

function watchFileForChat(chatId) {
  return path.join(getChatToolStateDir(chatId, toolName), "watch.json");
}

async function readWatchConfig(chatId) {
  return readJson(watchFileForChat(chatId), { enabled: false, chatId: Number(chatId) });
}

async function isWatchEnabled(chatId) {
  return Boolean((await readWatchConfig(chatId)).enabled);
}

async function enableWatch(chatId) {
  await writeJson(watchFileForChat(chatId), { enabled: true, chatId: Number(chatId), updatedAt: new Date().toISOString() });
  await setDaemonAutoStart(chatId, true);
}

async function setDaemonAutoStart(chatId, autoStart) {
  const runtime = daemonForChat(chatId, { autoStart });
  await registerManagedDaemon({ ...runtime.registration, autoStart });
}

async function readTasks() {
  return readArray(tasksFile);
}

async function writeTasks(tasks) {
  await writeJson(tasksFile, tasks);
}

function isTechnicalWhatsAppNotification(message) {
  const type = String(message.type || "").toLowerCase();
  const technicalTypes = new Set(["e2e_notification", "notification_template"]);
  return !compact(message.body)
    && !message.hasMedia
    && (technicalTypes.has(type) || type.includes("notification") || message.from === "status@broadcast");
}

function buildIncomingMessagePrompt(message, artifact, transcript = "") {
  return [
    "System event: Incoming WhatsApp message.",
    `from: ${message.fromName || message.from}`,
    message.fromPhone ? `fromPhone: ${message.fromPhone}` : null,
    message.chatName ? `chatName: ${message.chatName}` : null,
    message.isGroup ? `isGroup: true` : null,
    message.senderId && message.senderId !== message.from ? `senderId: ${message.senderId}` : null,
    `whatsappId: ${message.from}`,
    `receivedAt: ${message.receivedAt}`,
    `type: ${message.type}`,
    message.location?.mapsUrl ? `location: ${message.location.mapsUrl}` : null,
    message.location?.description ? `locationDescription: ${message.location.description}` : null,
    formatReactions(message.reactions) ? `reactions: ${formatReactions(message.reactions)}` : null,
    `text: ${transcript || message.body || "[non-text message]"}`,
    transcript ? `transcript: ${transcript}` : null,
    artifact ? `artifactId: ${artifact.id}` : null,
    artifact ? `mimeType: ${artifact.mimeType}` : null,
    artifact ? `kind: ${artifact.kind}` : null,
    "Treat this as a new WhatsApp reply that Arisa must reason about.",
    "If you need to reply by WhatsApp, use the whatsapp-web tool."
  ].filter(Boolean).join("\n");
}

function hasIncomingMessageTask(tasks, numericChatId, messageId) {
  return tasks.some((task) => task.source?.toolName === toolName && task.source?.chatId === numericChatId && task.source?.messageId === messageId);
}

function serializedWhatsAppId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  const serialized = value._serialized || value.$1 || value.serialized;
  if (serialized) return serialized;
  const remote = typeof value.remote === "object"
    ? value.remote?._serialized || value.remote?.$1
    : value.remote;
  return value.id || [value.fromMe ? "true" : "false", remote, value.id, value.participant].filter(Boolean).join("_");
}

async function reactionsFromMessage(message) {
  try {
    const lists = await message.getReactions?.();
    if (!Array.isArray(lists)) return [];
    return lists.flatMap((group) => (group.senders || []).map((sender) => ({
      emoji: sender.reaction || group.reaction || group.id || "",
      senderId: sender.senderId || "",
      timestamp: sender.timestamp || null
    }))).filter((item) => item.emoji || item.senderId);
  } catch {
    return [];
  }
}

function reactionFromEvent(reaction) {
  return {
    emoji: reaction.reaction || "",
    senderId: reaction.senderId || "",
    timestamp: reaction.timestamp || null
  };
}

async function captureReaction(ownerChatId, reaction) {
  const messageId = serializedWhatsAppId(reaction.msgId || reaction.parentMsgKey);
  if (!messageId) return;
  const current = await readInbox(ownerChatId);
  const found = current.find((item) => item.id === messageId);
  const existing = Array.isArray(found?.reactions) ? found.reactions : [];
  const next = reactionFromEvent(reaction);
  const reactions = existing.filter((item) => !(item.senderId === next.senderId && item.emoji === next.emoji));
  if (next.emoji) reactions.push(next);
  await updateInboxMessageReactions(ownerChatId, messageId, reactions);
}

function incomingMessageTask(chatId, message, artifact = null, transcript = "") {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    kind: "agent_task",
    runAt: now,
    payload: { chatId, prompt: buildIncomingMessagePrompt(message, artifact, transcript), artifactId: artifact?.id || "" },
    recurrence: null,
    source: { type: "tool", toolName, chatId, resourceId: message.from, messageId: message.id }
  };
}

async function enqueueArisaTaskForIncomingMessage(chatId, message, artifact = null, transcript = "") {
  const numericChatId = Number(chatId);
  const task = incomingMessageTask(numericChatId, message, artifact, transcript);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tasks = await readTasks();
    if (hasIncomingMessageTask(tasks, numericChatId, message.id)) return;
    tasks.push(task);
    await writeTasks(tasks);
    await sleep(100 + attempt * 150);
    if (hasIncomingMessageTask(await readTasks(), numericChatId, message.id)) return;
  }
  await writeChatStatus(chatId, { state: "ready", live: true, pid: process.pid, message: `WhatsApp is ready. Warning: failed to persist agent task for message ${message.id}.` });
}

async function enqueueWhatsAppReadyTask(chatId) {
  const numericChatId = Number(chatId);
  const tasks = await readTasks();
  const createdAt = new Date().toISOString();
  tasks.push({
    id: crypto.randomUUID(),
    status: "pending",
    createdAt,
    updatedAt: createdAt,
    kind: "agent_task",
    runAt: createdAt,
    payload: {
      chatId: numericChatId,
      prompt: "System event: WhatsApp Web login completed for this chat. Reply briefly in the user's language to confirm that WhatsApp is connected and ready.",
      artifactId: ""
    },
    recurrence: null,
    source: { type: "tool", toolName, chatId: numericChatId, event: "login_ready", occurredAt: createdAt }
  });
  await writeTasks(tasks);
}

function renderQr(qr) {
  let rendered = "";
  qrcodeTerminal.generate(qr, { small: true }, (text) => { rendered = text; });
  return rendered;
}

function makeClient(chatId) {
  const paths = chatPaths(chatId);
  const puppeteer = {
    headless: bool(config.HEADLESS, true) ? "new" : false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--renderer-process-limit=4",
      "--disable-site-isolation-trials"
    ]
  };
  if (config.CHROME_EXECUTABLE_PATH && existsSync(config.CHROME_EXECUTABLE_PATH)) puppeteer.executablePath = config.CHROME_EXECUTABLE_PATH;
  const clientOptions = {
    authStrategy: new LocalAuth({ dataPath: paths.sessionDir }),
    puppeteer,
    // Keep the browser and WhatsApp Web on a compatible modern Chrome identity.
    // The library default advertises Chrome 101, which current WhatsApp Web drops during startup.
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    webVersionCache: { type: "local", path: paths.webCacheDir, strict: bool(config.WEB_VERSION_CACHE_STRICT, false) }
  };
  if (config.WEB_VERSION) clientOptions.webVersion = config.WEB_VERSION;
  return new Client(clientOptions);
}

function mediaKind(mimeType = "", messageType = "") {
  if (mimeType.startsWith("audio/") || messageType === "ptt") return "audio";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function mediaExtension(mimeType = "") {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  const map = { "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4" };
  return map[base] || "bin";
}

function stickerPaths(chatId) {
  const root = path.join(getChatToolStateDir(chatId, toolName), "stickers");
  return { root, filesDir: path.join(root, "files"), previewsDir: path.join(root, "previews"), indexFile: path.join(root, "index.json") };
}

function parseTags(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "").split(/[,;#\n]/).map((item) => item.trim()).filter(Boolean);
}

async function readStickerIndex(chatId) {
  return readJson(stickerPaths(chatId).indexFile, []);
}

async function writeStickerIndex(chatId, stickers) {
  await writeJson(stickerPaths(chatId).indexFile, stickers);
}

async function writeFirstWebpFrame(inputPath, outputPath) {
  try {
    const image = new WebP.Image();
    await image.load(inputPath);
    if (!image.hasAnim) return "";
    const frames = await image.demux({ buffers: true, frame: 0 });
    const frame = Array.isArray(frames) ? frames[0] : frames;
    if (!frame) return "";
    await writeFile(outputPath, Buffer.isBuffer(frame) ? frame : Buffer.from(frame));
    return outputPath;
  } catch {
    return "";
  }
}

async function saveStickerToLibrary(ownerChatId, message, media, buffer, context = {}) {
  if (message.type !== "sticker" && media.mimetype?.split(";")[0].trim() !== "image/webp") return null;
  const paths = stickerPaths(ownerChatId);
  await mkdir(paths.filesDir, { recursive: true });
  await mkdir(paths.previewsDir, { recursive: true });
  const messageId = serializedWhatsAppId(message.id) || `${message.from}-${message.timestamp}-${Date.now()}`;
  const existing = (await readStickerIndex(ownerChatId)).filter((item) => item.messageId !== messageId);
  const id = crypto.createHash("sha1").update(messageId).digest("hex").slice(0, 12);
  const fileName = `${id}.webp`;
  const filePath = path.join(paths.filesDir, fileName);
  await writeFile(filePath, buffer);
  const isAnimated = buffer.includes(Buffer.from("ANIM"));
  let firstFramePath = "";
  if (isAnimated) {
    const previewPath = path.join(paths.previewsDir, `${id}-frame1.webp`);
    firstFramePath = await writeFirstWebpFrame(filePath, previewPath);
  }
  const sticker = {
    id,
    messageId,
    fileName,
    filePath,
    firstFramePath,
    animated: isAnimated,
    mimeType: media.mimetype.split(";")[0].trim(),
    tags: [],
    uses: 0,
    senderId: context.senderId || message.author || message.from,
    fromName: context.fromName || "",
    chatId: message.from,
    chatName: context.chatName || "",
    body: message.body || "",
    receivedAt: new Date((message.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString()
  };
  existing.push(sticker);
  existing.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  await writeStickerIndex(ownerChatId, existing.slice(-300));
  return sticker;
}

function formatStickerList(stickers) {
  if (!stickers.length) return "No saved stickers yet.";
  return stickers.map((item, index) => `${index + 1}. ${item.id}${item.tags?.length ? ` #${item.tags.join(" #")}` : ""}${item.description ? ` — ${item.description}` : ""}${item.fromName ? ` from ${item.fromName}` : ""}${item.receivedAt ? ` at ${item.receivedAt}` : ""}`).join("\n");
}

async function selectSticker(chatId, { id, tag } = {}) {
  const stickers = await readStickerIndex(chatId);
  const selected = id
    ? stickers.find((item) => item.id === id)
    : [...stickers].reverse().find((item) => !tag || item.tags?.includes(tag));
  if (!selected) throw new Error(id ? `Sticker not found: ${id}` : `No sticker found${tag ? ` for tag ${tag}` : ""}`);
  return selected;
}

async function tagSticker(chatId, id, tags) {
  const stickers = await readStickerIndex(chatId);
  const sticker = stickers.find((item) => item.id === id);
  if (!sticker) throw new Error(`Sticker not found: ${id}`);
  sticker.tags = [...new Set([...(sticker.tags || []), ...parseTags(tags)])];
  await writeStickerIndex(chatId, stickers);
  return sticker;
}

async function markStickerUsed(chatId, id) {
  const stickers = await readStickerIndex(chatId);
  const sticker = stickers.find((item) => item.id === id);
  if (sticker) {
    sticker.uses = Number(sticker.uses || 0) + 1;
    sticker.lastUsedAt = new Date().toISOString();
    await writeStickerIndex(chatId, stickers);
  }
}

async function downloadMessageMedia(message, attempts = 4) {
  if (!message.hasMedia) return null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const media = await message.downloadMedia();
      if (media?.data && media?.mimetype) return media;
    } catch {}
    await sleep(750 + attempt * 750);
  }
  return null;
}

async function storeIncomingMediaArtifact(message, chatId, context = {}) {
  const media = await downloadMessageMedia(message);
  if (!media?.data || !media?.mimetype) return null;

  const paths = chatPaths(chatId);
  const mimeType = media.mimetype.split(";")[0].trim();
  const kind = mediaKind(mimeType, message.type);
  const fileName = media.filename || `whatsapp-${serializedWhatsAppId(message.id) || Date.now()}.${mediaExtension(mimeType)}`;
  await mkdir(paths.mediaTmpDir, { recursive: true });
  const tmpPath = path.join(paths.mediaTmpDir, `${crypto.randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  const buffer = Buffer.from(media.data, "base64");
  await writeFile(tmpPath, buffer);
  await saveStickerToLibrary(chatId, message, media, buffer, context);
  try {
    return await artifactStore.forChat(chatId).createFromFile({
      originalPath: tmpPath,
      fileName,
      kind,
      mimeType,
      source: { type: "tool", toolName, whatsappMessageId: serializedWhatsAppId(message.id) },
      metadata: { whatsappFrom: message.from, whatsappAuthor: message.author || "", whatsappType: message.type }
    });
  } finally {
    await unlink(tmpPath).catch(() => {});
    await rmdir(paths.mediaTmpDir).catch(() => {});
  }
}

function restartableWhatsAppError(error) {
  const message = String(error?.message || error || "");
  return /Execution context was destroyed|ProtocolError|Target closed|Session closed|frame was detached|detached Frame|browser has disconnected|Navigation failed|Cannot find context|Most likely the page has been closed/i.test(message);
}

function shortError(error) {
  return String(error?.message || error || "unknown error").split("\n")[0].slice(0, 300);
}

function isAudioArtifact(artifact, message = {}) {
  return artifact?.kind === "audio" || String(artifact?.mimeType || "").startsWith("audio/") || ["ptt", "audio"].includes(String(message.type || "").toLowerCase());
}

async function transcribeIncomingAudio(chatId, message, artifact) {
  if (!bool(config.TRANSCRIBE_AUDIO, true) || !artifact?.id || !isAudioArtifact(artifact, message)) return "";
  try {
    const arisa = createArisaClient({ toolName, chatId: normalizeChatId(chatId) });
    const result = await arisa.tools.run({
      name: config.TRANSCRIBE_TOOL || "openai-transcribe",
      artifactId: artifact.id
    }, { timeoutMs: 180_000 });
    if (!result.ok) return "";
    return compact(result.output?.text || result.output?.json?.text || "");
  } catch {
    return "";
  }
}

async function captureIncomingMessage(ownerChatId, message) {
  if (message.fromMe) {
    await writeChatStatus(ownerChatId, { state: "ready", live: true, pid: process.pid, message: "WhatsApp is ready." });
    return;
  }
  if (isTechnicalWhatsAppNotification(message)) {
    await writeChatStatus(ownerChatId, { state: "ready", live: true, pid: process.pid, message: `WhatsApp is ready. Ignored system notification: ${message.type || "unknown"}.` });
    return;
  }
  let contact = null;
  let chat = null;
  try { contact = await message.getContact(); } catch {}
  try { chat = await message.getChat(); } catch {}
  const senderId = message.author || message.from;
  const chatId = message.from;
  const isGroup = Boolean(chat?.isGroup || /@g\.us$/.test(String(chatId)));
  const location = locationFromMessage(message);
  const reactions = await reactionsFromMessage(message);
  const serializedId = serializedWhatsAppId(message.id);
  const inboxMessage = {
    id: serializedId || `${message.from}-${message.timestamp}-${Date.now()}`,
    whatsappMessageId: serializedId,
    rawId: message.id || null,
    from: chatId,
    chatId,
    chatName: compact(chat?.name || ""),
    isGroup,
    senderId,
    fromPhone: String(senderId || chatId || "").replace(/@(c|g)\.us$/, ""),
    fromName: compact(contact?.pushname || contact?.name || contact?.number || ""),
    body: messageBodyForInbox(message),
    type: message.type || "unknown",
    location,
    reactions,
    timestamp: message.timestamp || Math.floor(Date.now() / 1000),
    receivedAt: new Date((message.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    read: false
  };

  if (!(await appendInboxMessage(ownerChatId, inboxMessage))) {
    if (reactions.length) await updateInboxMessageReactions(ownerChatId, inboxMessage.id, reactions);
    return;
  }
  if (!(await isWatchEnabled(ownerChatId))) return;

  const artifact = await storeIncomingMediaArtifact(message, ownerChatId, { senderId, fromName: inboxMessage.fromName, chatName: inboxMessage.chatName });
  const transcript = await transcribeIncomingAudio(ownerChatId, inboxMessage, artifact);
  await enqueueArisaTaskForIncomingMessage(ownerChatId, inboxMessage, artifact, transcript);
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.idleShutdownMs = number(config.IDLE_SHUTDOWN_MS, 300000);
  }

  get(chatId) {
    return this.sessions.get(normalizeChatId(chatId));
  }

  touch(chatId) {
    const record = this.get(chatId);
    if (record) record.lastActivity = Date.now();
  }

  async ensureClient(chatId) {
    const normalizedChatId = normalizeChatId(chatId);
    const existing = this.sessions.get(normalizedChatId);
    if (existing?.client) {
      existing.lastActivity = Date.now();
      return existing;
    }

    const paths = chatPaths(normalizedChatId);
    await ensureChatState(paths);
    await cleanupBrowserLocks(paths);
    await writeChatStatus(normalizedChatId, {
      state: "connecting",
      live: true,
      pid: process.pid,
      message: "Starting WhatsApp Web client for this chat."
    });

    const client = makeClient(normalizedChatId);
    const record = {
      chatId: normalizedChatId,
      client,
      initializing: null,
      lastActivity: Date.now(),
      closingReason: "",
      loginNotificationPending: false,
      restarting: false,
      restartTimer: null,
      startupTimer: null
    };
    this.sessions.set(normalizedChatId, record);
    record.startupTimer = setTimeout(async () => {
      const status = await readChatStatus(normalizedChatId, {}).catch(() => ({}));
      if (status.state === "ready" || status.state === "needs_login" || record.restarting) return;
      if (await isWatchEnabled(normalizedChatId)) this.scheduleRestart(normalizedChatId, `startup timeout while ${status.state || "connecting"}`);
    }, number(config.STARTUP_TIMEOUT_MS, 90000));

    client.on("qr", async (qr) => {
      record.loginNotificationPending = true;
      await QRCode.toFile(paths.qrImageFile, qr, { margin: 2, width: 900 }).catch(() => {});
      await writeChatStatus(normalizedChatId, {
        state: "needs_login",
        live: true,
        pid: process.pid,
        qr,
        qrText: renderQr(qr),
        message: "Scan this QR code with WhatsApp > Linked devices."
      });
    });
    client.on("authenticated", async () => {
      await writeChatStatus(normalizedChatId, {
        state: "connecting",
        live: true,
        pid: process.pid,
        message: "Authenticated, waiting for WhatsApp to be ready."
      });
    });
    client.on("ready", async () => {
      if (record.startupTimer) clearTimeout(record.startupTimer);
      record.startupTimer = null;
      record.lastActivity = Date.now();
      await writeChatStatus(normalizedChatId, { state: "ready", live: true, pid: process.pid, message: "WhatsApp is ready." });
      if (record.loginNotificationPending) {
        record.loginNotificationPending = false;
        await enqueueWhatsAppReadyTask(normalizedChatId);
      }
    });
    client.on("message", async (message) => {
      record.lastActivity = Date.now();
      try {
        await captureIncomingMessage(normalizedChatId, message);
      } catch (error) {
        await writeChatStatus(normalizedChatId, { state: "ready", live: true, pid: process.pid, message: `WhatsApp is ready. Inbox warning: ${error.message || error}` });
      }
    });
    client.on("message_create", async (message) => {
      record.lastActivity = Date.now();
      if (message.fromMe) await writeChatStatus(normalizedChatId, { state: "ready", live: true, pid: process.pid, message: "WhatsApp is ready." });
    });
    client.on("message_reaction", async (reaction) => {
      record.lastActivity = Date.now();
      try {
        await captureReaction(normalizedChatId, reaction);
      } catch (error) {
        await writeChatStatus(normalizedChatId, { state: "ready", live: true, pid: process.pid, message: `WhatsApp is ready. Reaction warning: ${error.message || error}` });
      }
    });
    client.on("auth_failure", async (message) => {
      if (record.startupTimer) clearTimeout(record.startupTimer);
      record.startupTimer = null;
      this.sessions.delete(normalizedChatId);
      await writeChatStatus(normalizedChatId, { state: "expired", live: false, pid: process.pid, message: `Authentication failed: ${message}` });
    });
    client.on("error", async (error) => {
      if (restartableWhatsAppError(error) && await isWatchEnabled(normalizedChatId)) {
        this.scheduleRestart(normalizedChatId, `client error: ${shortError(error)}`);
      }
    });
    client.on("disconnected", async (reason) => {
      if (record.startupTimer) {
        clearTimeout(record.startupTimer);
        record.startupTimer = null;
      }
      if (["idle", "logout", "restart"].includes(record.closingReason)) return;
      this.sessions.delete(normalizedChatId);
      if (await isWatchEnabled(normalizedChatId)) {
        this.scheduleRestart(normalizedChatId, `disconnected: ${reason}`);
        return;
      }
      await writeChatStatus(normalizedChatId, { state: "expired", live: false, pid: process.pid, message: `Disconnected: ${reason}` });
    });

    record.initializing = client.initialize().catch(async (error) => {
      if (record.startupTimer) {
        clearTimeout(record.startupTimer);
        record.startupTimer = null;
      }
      this.sessions.delete(normalizedChatId);
      try { await client.destroy(); } catch {}
      if (restartableWhatsAppError(error) && await isWatchEnabled(normalizedChatId)) {
        this.scheduleRestart(normalizedChatId, `initialize error: ${shortError(error)}`);
        return;
      }
      await writeChatStatus(normalizedChatId, { state: "failed", live: false, pid: process.pid, message: error.message || String(error) });
    });
    return record;
  }

  async waitReady(chatId, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await readChatStatus(chatId, {});
      if (status.state === "ready" && status.live) return status;
      if (status.state === "needs_login") {
        throw new Error("WhatsApp session for this chat needs login. Run whatsapp-web login and scan the QR code.");
      }
      if (status.state === "expired") {
        throw new Error(status.message || "WhatsApp session for this chat expired. Run whatsapp-web login again.");
      }
      if (status.state === "failed") {
        throw new Error(status.message || "WhatsApp session for this chat failed.");
      }
      await sleep(500);
    }
    throw new Error(`${toolName} session for chat ${chatId} was not ready after ${timeoutMs}ms`);
  }

  async react(chatId, job) {
    const record = await this.ensureClient(chatId);
    await this.waitReady(chatId, number(job.readyTimeoutMs, number(config.READY_TIMEOUT_MS, 120000)));
    record.lastActivity = Date.now();
    const messageId = String(job.messageId || "").trim();
    const emoji = String(job.emoji ?? job.reaction ?? "👀");
    if (!messageId) throw new Error("messageId is required for react");
    let message = await record.client.getMessageById(messageId).catch(() => null);
    if (!message) message = await this.findRecentMessageBySyntheticId(record.client, messageId);
    if (!message) message = await this.findRecentMessageByText(record.client, job);
    if (!message) throw new Error(`Message not found: ${messageId}`);
    await message.react(emoji);
    record.lastActivity = Date.now();
    return { messageId: serializedMessageId(message) || messageId, emoji, sessionChatId: normalizeChatId(chatId) };
  }

  async findRecentMessageBySyntheticId(client, messageId) {
    const match = String(messageId).match(/^(.+@g\.us)-(\d{9,})-\d+$/);
    if (!match) return null;
    const [, chatId, timestampText] = match;
    const expectedTimestamp = Number(timestampText);
    if (!Number.isFinite(expectedTimestamp)) return null;
    const chat = await client.getChatById(chatId).catch(() => null);
    if (!chat?.fetchMessages) return null;
    const messages = await chat.fetchMessages({ limit: 50 });
    return messages.find((message) => Number(message.timestamp) === expectedTimestamp) || null;
  }

  async findRecentMessageByText(client, job) {
    const chatId = String(job.chatId || job.whatsappId || job.to || "").trim();
    const body = String(job.body || job.text || job.messageText || "").trim();
    if (!chatId || (!body && !bool(job.latestFallback, false))) return null;
    const chat = await client.getChatById(chatId).catch(() => null);
    if (!chat?.fetchMessages) return null;
    const messages = await chat.fetchMessages({ limit: 100 });
    const newestFirst = [...messages].reverse();
    return (body ? newestFirst.find((message) => String(message.body || "").trim() === body) : null) || (bool(job.latestFallback, false) ? newestFirst[0] : null);
  }

  async getMessageReactions(chatId, job) {
    const record = await this.ensureClient(chatId);
    await this.waitReady(chatId, number(job.readyTimeoutMs, number(config.READY_TIMEOUT_MS, 120000)));
    record.lastActivity = Date.now();
    const messageId = String(job.messageId || "").trim();
    if (!messageId) throw new Error("messageId is required for reactions");
    const message = await record.client.getMessageById(messageId);
    if (!message) throw new Error(`Message not found: ${messageId}`);
    const reactions = await reactionsFromMessage(message);
    await updateInboxMessageReactions(chatId, messageId, reactions);
    record.lastActivity = Date.now();
    return { messageId, reactions, sessionChatId: normalizeChatId(chatId) };
  }

  async deleteRecentSent(chatId, job) {
    const record = await this.ensureClient(chatId);
    await this.waitReady(chatId, number(job.readyTimeoutMs, number(config.READY_TIMEOUT_MS, 120000)));
    record.lastActivity = Date.now();
    const message = await findSentMessageToDelete(record.client, job);
    if (!message) throw new Error("No matching recent sent message found");
    const messageId = serializedWhatsAppId(message.id);
    const everyone = bool(job.everyone, true);
    try {
      await message.delete(everyone, bool(job.clearMedia, true));
    } catch (error) {
      if (everyone) await message.delete(false, bool(job.clearMedia, false));
      else throw error;
    }
    record.lastActivity = Date.now();
    return { messageId, chatId: normalizeRecipient(job.to), sessionChatId: normalizeChatId(chatId), deleted: true };
  }

  async syncRecentMessages(chatId, { limit = 20 } = {}) {
    const record = await this.ensureClient(chatId);
    const status = await readChatStatus(chatId, {});
    if (status.state !== "ready" || !status.live) return { synced: 0, skipped: "not ready" };
    const ids = await knownWhatsAppChatIds(chatId);
    let synced = 0;
    for (const whatsappChatId of ids) {
      try {
        const chat = await record.client.getChatById(whatsappChatId);
        if (!chat?.fetchMessages) continue;
        const messages = await chat.fetchMessages({ limit });
        for (const message of messages) {
          const before = (await readInbox(chatId)).length;
          await captureIncomingMessage(chatId, message);
          const after = (await readInbox(chatId)).length;
          if (after > before) synced += 1;
        }
      } catch (error) {
        if (restartableWhatsAppError(error) && await isWatchEnabled(chatId)) this.scheduleRestart(chatId, `sync error: ${shortError(error)}`);
      }
    }
    return { synced, chats: ids.length };
  }

  async setProfilePicture(chatId, job) {
    const record = await this.ensureClient(chatId);
    await this.waitReady(chatId, number(job.readyTimeoutMs, number(config.READY_TIMEOUT_MS, 120000)));
    if (!job.mediaPath) throw new Error("An image artifact is required");
    const media = MessageMedia.fromFilePath(job.mediaPath);
    const updated = await withOperationTimeout(
      () => record.client.setProfilePicture(media),
      number(job.operationTimeoutMs, 45000),
      "WhatsApp profile picture update"
    );
    if (!updated) throw new Error("WhatsApp did not confirm the profile picture update");
    record.lastActivity = Date.now();
    return { sessionChatId: normalizeChatId(chatId), updated: true };
  }

  async send(chatId, job) {
    let record = await this.ensureClient(chatId);
    await this.waitReady(chatId, number(job.readyTimeoutMs, number(config.READY_TIMEOUT_MS, 120000)));
    record.lastActivity = Date.now();
    const whatsappChatId = normalizeRecipient(job.to);
    if (bool(job.dedupe, true)) {
      const duplicate = await findRecentSentMatching(record.client, job, { withinMs: number(job.dedupeWindowMs, 5 * 60 * 1000) });
      if (duplicate) {
        record.lastActivity = Date.now();
        return { chatId: whatsappChatId, sessionChatId: normalizeChatId(chatId), messageId: serializedMessageId(duplicate), duplicateSkipped: true };
      }
    }
    let presence = null;
    try {
      presence = await humanizeSend(record.client, whatsappChatId, job);
      const sendOptions = messageSendOptions(job);
      const sent = await withOperationTimeout(async () => {
        const content = job.mediaPath ? MessageMedia.fromFilePath(job.mediaPath) : job.message;
        const options = job.mediaPath
          ? { ...sendOptions, caption: job.message || "", sendMediaAsSticker: bool(job.asSticker, false) }
          : sendOptions;
        try {
          return await record.client.sendMessage(whatsappChatId, content, options);
        } catch (error) {
          if (String(error?.message || error) !== "r") throw error;
          const chat = await record.client.getChatById(whatsappChatId);
          return chat.sendMessage(content, options);
        }
      }, number(job.sendTimeoutMs, 45000), "WhatsApp send");
      await finishHumanizeSend(record.client, presence);
      record.lastActivity = Date.now();
      return { chatId: whatsappChatId, sessionChatId: normalizeChatId(chatId), messageId: serializedMessageId(sent) };
    } catch (error) {
      await finishHumanizeSend(record.client, presence);
      const maybeSent = await withOperationTimeout(
        () => findRecentSentMatching(record.client, job, { withinMs: number(job.recoverWindowMs, 2 * 60 * 1000) }),
        10000,
        "WhatsApp sent-message recovery"
      ).catch(() => null);
      if (maybeSent) {
        record.lastActivity = Date.now();
        return { chatId: whatsappChatId, sessionChatId: normalizeChatId(chatId), messageId: serializedMessageId(maybeSent), recoveredAfterError: true, warning: shortError(error) };
      }
      if (restartableWhatsAppError(error) || /timed out/i.test(shortError(error))) {
        await this.restart(chatId, `send failure: ${shortError(error)}`);
      }
      throw error;
    }
  }

  scheduleRestart(chatId, reason) {
    const normalizedChatId = normalizeChatId(chatId);
    const record = this.sessions.get(normalizedChatId) || { chatId: normalizedChatId };
    if (record.startupTimer) {
      clearTimeout(record.startupTimer);
      record.startupTimer = null;
    }
    if (record.restartTimer || record.restarting) return;
    record.restartTimer = setTimeout(() => {
      record.restartTimer = null;
      this.restart(normalizedChatId, reason).catch((error) => {
        writeChatStatus(normalizedChatId, { state: "failed", live: false, pid: process.pid, message: `Auto-restart failed: ${shortError(error)}` }).catch(() => {});
      });
    }, 2000);
    if (!this.sessions.has(normalizedChatId)) this.sessions.set(normalizedChatId, record);
    writeChatStatus(normalizedChatId, { state: "reconnecting", live: false, pid: process.pid, message: `WhatsApp client error; auto-restarting. ${reason}` }).catch(() => {});
  }

  async restart(chatId, reason) {
    const normalizedChatId = normalizeChatId(chatId);
    const record = this.sessions.get(normalizedChatId);
    if (record?.restarting) return;
    if (record) record.restarting = true;
    await writeChatStatus(normalizedChatId, { state: "reconnecting", live: false, pid: process.pid, message: `Restarting WhatsApp client: ${reason}` });
    if (record?.startupTimer) {
      clearTimeout(record.startupTimer);
      record.startupTimer = null;
    }
    if (record?.client) {
      record.closingReason = "restart";
      await withOperationTimeout(() => record.client.destroy(), 10000, "WhatsApp client shutdown").catch(() => {});
    }
    this.sessions.delete(normalizedChatId);
    if (!(await isWatchEnabled(normalizedChatId))) {
      await writeChatStatus(normalizedChatId, { state: "ready", live: false, pid: process.pid, message: "WhatsApp client stopped after restart trigger because watch is disabled." });
      return;
    }
    await sleep(1500);
    await this.ensureClient(normalizedChatId);
  }

  async logout(chatId) {
    const normalizedChatId = normalizeChatId(chatId);
    const record = this.sessions.get(normalizedChatId);
    if (record?.startupTimer) {
      clearTimeout(record.startupTimer);
      record.startupTimer = null;
    }
    if (record?.client) {
      record.closingReason = "logout";
      try { await record.client.destroy(); } catch {}
    }
    this.sessions.delete(normalizedChatId);
    const paths = chatPaths(normalizedChatId);
    await rm(paths.sessionDir, { recursive: true, force: true });
    await writeChatStatus(normalizedChatId, { state: "logged_out", live: false, pid: process.pid, message: "Local WhatsApp session removed for this chat." });
    return readChatStatus(normalizedChatId, {});
  }

  async transcribeMessageMedia(chatId, job) {
    const record = await this.ensureClient(chatId);
    await this.waitReady(chatId, number(job.readyTimeoutMs, number(config.READY_TIMEOUT_MS, 120000)));
    const messageId = String(job.messageId || "").trim();
    if (!messageId) throw new Error("messageId is required");
    let message = await record.client.getMessageById(messageId);
    if (!message && job.remote) {
      const chat = await record.client.getChatById(job.remote);
      const messages = await chat.fetchMessages({ limit: number(job.limit, 50) });
      message = messages.find((item) => serializedWhatsAppId(item.id) === messageId || serializedWhatsAppId(item.id).includes(messageId));
    }
    if (!message) throw new Error(`WhatsApp message not found: ${messageId}`);
    let artifact = await storeIncomingMediaArtifact(message, chatId, { transcribedOnDemand: true });
    if (!artifact?.id && job.remote) {
      const chat = await record.client.getChatById(job.remote);
      const messages = await chat.fetchMessages({ limit: number(job.limit, 50) });
      const fetched = messages.find((item) => serializedWhatsAppId(item.id) === messageId || serializedWhatsAppId(item.id).includes(messageId));
      if (fetched) artifact = await storeIncomingMediaArtifact(fetched, chatId, { transcribedOnDemand: true, fetchedFromChat: true });
    }
    if (!artifact?.id) throw new Error("Could not download media from WhatsApp message");
    const transcript = await transcribeIncomingAudio(chatId, { type: message.type || job.messageType || "audio" }, artifact);
    if (!transcript) throw new Error("Audio transcription failed or returned empty text");
    record.lastActivity = Date.now();
    return { messageId, artifactId: artifact.id, mimeType: artifact.mimeType, kind: artifact.kind, transcript };
  }

  async shutdownIdleClients() {
    if (this.idleShutdownMs <= 0) return;
    for (const [chatId, record] of this.sessions) {
      if (await isWatchEnabled(chatId)) continue;
      if (Date.now() - record.lastActivity < this.idleShutdownMs) continue;
      if (record.startupTimer) {
        clearTimeout(record.startupTimer);
        record.startupTimer = null;
      }
      record.closingReason = "idle";
      try { await record.client.destroy(); } catch {}
      this.sessions.delete(chatId);
      const status = await readChatStatus(chatId, {});
      if (status.state === "ready") {
        await writeChatStatus(chatId, { state: "ready", live: false, pid: process.pid, message: "WhatsApp session is ready and will reconnect on demand." });
      } else {
        await writeChatStatus(chatId, { live: false, pid: process.pid });
      }
    }
  }

}

async function processJob(manager, job) {
  if (!job?.payload?.type) throw new Error("Invalid WhatsApp command");
  const chatId = normalizeChatId(job.chatId);
  const paths = chatPaths(chatId);
  await useChatConfig(chatId);
  if (job.payload.type === "ensure") {
    await withChatLock(paths, () => manager.ensureClient(chatId));
    return readChatStatus(chatId, {});
  }
  if (job.payload.type === "send") {
    return manager.send(chatId, job.payload);
  }
  if (job.payload.type === "setProfilePicture") {
    return manager.setProfilePicture(chatId, job.payload);
  }
  if (job.payload.type === "delete") {
    return manager.deleteRecentSent(chatId, job.payload);
  }
  if (job.payload.type === "react") {
    return manager.react(chatId, job.payload);
  }
  if (job.payload.type === "reactions") {
    return manager.getMessageReactions(chatId, job.payload);
  }
  if (job.payload.type === "sync") {
    return manager.syncRecentMessages(chatId, { limit: number(job.payload.limit, 20) });
  }
  if (job.payload.type === "transcribe") {
    return manager.transcribeMessageMedia(chatId, job.payload);
  }
  if (job.payload.type === "debugChats") {
    const record = await manager.ensureClient(chatId);
    const chats = await record.client.getChats();
    const query = String(job.payload.query || "").toLowerCase();
    return chats
      .filter((chat) => !query || String(chat.name || chat.id?._serialized || "").toLowerCase().includes(query))
      .slice(0, number(job.payload.limit, 20))
      .map((chat) => ({ id: chat.id?._serialized, name: chat.name, isGroup: chat.isGroup }));
  }
  if (job.payload.type === "logout") {
    return withChatLock(paths, () => manager.logout(chatId));
  }
  throw new Error(`Unknown command type: ${job.payload.type}`);
}

async function whatsappHealth(manager, chatId) {
  const watching = await isWatchEnabled(chatId);
  let record = manager.get(chatId);
  if (!record?.client && watching) record = await manager.ensureClient(chatId);
  if (!record?.client) return { message: "WhatsApp scoped daemon is healthy and idle" };

  const capability = await readChatStatus(chatId, {});
  if (capability.state === "needs_login" && capability.qr) {
    return { message: "WhatsApp browser is healthy and waiting for login", capabilityState: "needs_login" };
  }
  // Initialization has not reached the QR/login state yet. Do not destroy a
  // healthy browser mid-navigation just because WhatsApp is not CONNECTED.
  if (["connecting", "reconnecting"].includes(capability.state)) {
    return { message: "WhatsApp browser is initializing", capabilityState: capability.state };
  }

  try {
    const clientState = await withOperationTimeout(() => record.client.getState(), 15000, "WhatsApp connection check");
    if (clientState !== "CONNECTED") throw new Error(`WhatsApp client is not connected: ${clientState || capability.state || "unknown"}`);
    return { message: "WhatsApp client and browser are connected", clientState };
  } catch (error) {
    if (!watching) throw error;
    await manager.restart(chatId, `health check failed: ${shortError(error)}`);
    record = manager.get(chatId);
    await manager.waitReady(chatId, 60000);
    const clientState = await withOperationTimeout(() => record.client.getState(), 15000, "WhatsApp connection recheck");
    if (clientState !== "CONNECTED") throw new Error(`WhatsApp client did not recover: ${clientState || "unknown"}`);
    return { message: "WhatsApp client recovered and is connected", clientState, recovered: true };
  }
}

async function runDaemon() {
  const launch = await readDaemonLaunchContext({ expectedToolName: toolName });
  if (launch?.scope?.type !== "chat") {
    throw new Error("whatsapp-web daemon requires a chat scope");
  }
  const chatId = normalizeChatId(launch.startupContext?.chatId || launch.scope.chatId);
  await useChatConfig(chatId);
  const daemon = daemonForChat(chatId, { autoStart: launch.autoStart });
  const manager = new SessionManager();

  const restartWatchedAfterUnhandled = (error) => {
    const reason = `unhandled WhatsApp runtime error: ${shortError(error)}`;
    daemon.writeStatus({
      state: "degraded",
      lastError: { at: new Date().toISOString(), phase: "runtime", message: reason },
      message: reason
    }).catch(() => {});
    isWatchEnabled(chatId).then((enabled) => {
      if (enabled) manager.scheduleRestart(chatId, reason);
    }).catch(() => {});
  };
  process.on("unhandledRejection", restartWatchedAfterUnhandled);
  process.on("uncaughtException", restartWatchedAfterUnhandled);

  if (await isWatchEnabled(chatId)) {
    manager.ensureClient(chatId).catch((error) => {
      daemon.writeStatus({
        state: "degraded",
        lastError: { at: new Date().toISOString(), phase: "client-start", message: error?.message || String(error) },
        message: error?.message || String(error)
      }).catch(() => {});
    });
  }

  setInterval(async () => {
    if (!(await isWatchEnabled(chatId))) return;
    manager.syncRecentMessages(chatId, { limit: number(config.SYNC_RECENT_LIMIT, 20) }).catch((error) => {
      daemon.writeStatus({
        state: "degraded",
        lastError: { at: new Date().toISOString(), phase: "sync", message: error?.message || String(error) },
        message: error?.message || String(error)
      }).catch(() => {});
    });
  }, number(config.SYNC_INTERVAL_MS, 45000));

  const watching = await isWatchEnabled(chatId);
  await daemon.workLoop({
    idleTimeoutMs: watching ? 0 : number(config.IDLE_SHUTDOWN_MS, 300000),
    beforeExit: () => manager.shutdownIdleClients(),
    processJob: (job) => processJob(manager, job),
    healthCheck: () => whatsappHealth(manager, chatId),
    recover: async () => {
      if (!(await isWatchEnabled(chatId))) return true;
      await manager.restart(chatId, "daemon health check failed");
      return true;
    }
  });
}

function getMessage(request) {
  return String(request.args?.message || request.text || request.artifact?.text || "").trim();
}

function naturalTypingMs(job, config, maxMs) {
  const configured = boundedNumber(job.typingMs, number(config.HUMANIZE_SEND_TYPING_MS, 0), 0, maxMs);
  if (configured > 0) return configured;
  const characters = String(job.text || job.message || "").trim().length;
  return Math.min(maxMs, Math.max(2500, Math.round(1500 + characters * 55)));
}

async function humanizeSend(client, whatsappChatId, job) {
  if (!bool(job.humanizeSend, bool(config.HUMANIZE_SEND, false))) return null;
  const maxMs = number(config.HUMANIZE_SEND_MAX_MS, 60000);
  const initialDelayMs = boundedNumber(job.initialDelayMs, number(config.HUMANIZE_SEND_INITIAL_DELAY_MS, 0), 0, maxMs);
  const typingMs = naturalTypingMs(job, config, maxMs);
  const onlineLeadMs = boundedNumber(job.onlineLeadMs, number(config.HUMANIZE_SEND_ONLINE_LEAD_MS, 1500), 0, maxMs);
  if (initialDelayMs > 0) await sleep(initialDelayMs);
  let online = false;
  let chat = null;
  try {
    if (client?.sendPresenceAvailable) {
      try {
        await client.sendPresenceAvailable();
        online = true;
      } catch {
        // Presence is cosmetic; do not block an outgoing message.
      }
    }
    if (onlineLeadMs > 0) await sleep(onlineLeadMs);
    try {
      chat = await client.getChatById(whatsappChatId);
    } catch {
      // Chat lookup is only needed for typing and may be incompatible with a new WA Web build.
    }
    const startedAt = Date.now();
    while (chat?.sendStateTyping && Date.now() - startedAt < typingMs) {
      try {
        await chat.sendStateTyping();
      } catch {
        // WhatsApp Web currently throws `r` for typing on some chats; send anyway.
        break;
      }
      const remainingMs = typingMs - (Date.now() - startedAt);
      if (remainingMs > 0) await sleep(Math.min(7000, remainingMs));
    }
    return { online };
  } finally {
    if (chat?.clearState) await chat.clearState().catch(() => {});
  }
}

async function finishHumanizeSend(client, presence) {
  if (!presence?.online || !client?.sendPresenceUnavailable) return;
  const maxMs = number(config.HUMANIZE_SEND_MAX_MS, 60000);
  const lingerMs = boundedNumber(null, number(config.HUMANIZE_SEND_POST_SEND_ONLINE_MS, 2500), 0, maxMs);
  if (client?.sendPresenceAvailable) await client.sendPresenceAvailable().catch(() => {});
  if (lingerMs > 0) await sleep(lingerMs);
  await client.sendPresenceUnavailable().catch(() => {});
}

function serializedMessageId(message) {
  return serializedWhatsAppId(message?.id);
}

function messageAgeMs(message) {
  const timestamp = Number(message?.timestamp || 0);
  if (!timestamp) return Number.POSITIVE_INFINITY;
  return Date.now() - timestamp * 1000;
}

function sentMessageMatchesJob(message, job, { contains = false, withinMs = 0 } = {}) {
  if (!message?.fromMe) return false;
  if (withinMs > 0 && messageAgeMs(message) > withinMs) return false;
  if (job.mediaPath && !message.hasMedia) return false;
  const expected = String(job.text || job.message || "").trim().toLowerCase();
  if (!expected) return true;
  const actual = String(message.body || "").trim().toLowerCase();
  return contains ? actual.includes(expected) : actual === expected;
}

async function findRecentSentMatching(client, job, options = {}) {
  try {
    const whatsappChatId = normalizeRecipient(job.to);
    const chat = await client.getChatById(whatsappChatId);
    if (!chat?.fetchMessages) return null;
    const messages = await chat.fetchMessages({ limit: number(job.limit, 30) });
    return [...messages].reverse().find((message) => sentMessageMatchesJob(message, job, options)) || null;
  } catch {
    // Dedupe/recovery must never prevent a fresh send when WA Web message lookup changes.
    return null;
  }
}

async function findSentMessageToDelete(client, job) {
  const messageId = String(job.messageId || "").trim();
  if (messageId) return client.getMessageById(messageId);
  return findRecentSentMatching(client, job, { contains: true });
}

function messageSendOptions(job = {}) {
  const quotedMessageId = String(job.quotedMessageId || job.quoteMessageId || job.replyTo || "").trim();
  const options = { sendSeen: false };
  if (quotedMessageId) options.quotedMessageId = quotedMessageId;
  return options;
}

function sendTimingArgs(args = {}) {
  return {
    humanizeSend: args.humanize ?? args.humanizeSend,
    initialDelayMs: args.initialDelayMs ?? args.delayMs ?? args.sendDelayMs,
    onlineLeadMs: args.onlineLeadMs,
    typingMs: args.typingMs,
    dedupe: args.dedupe,
    dedupeWindowMs: args.dedupeWindowMs,
    recoverWindowMs: args.recoverWindowMs,
    asSticker: args.asSticker,
    quotedMessageId: args.quotedMessageId ?? args.quoteMessageId ?? args.replyTo
  };
}

async function zoomProfilePicture(chatId, sourcePath, args = {}) {
  const zoom = Math.min(3, Math.max(1, Number(args.zoom) || 1));
  if (zoom <= 1) return { path: sourcePath, generated: false };
  const focusX = Math.min(1, Math.max(0, Number(args.focusX) || 0.55));
  const focusY = Math.min(1, Math.max(0, Number(args.focusY) || 0.08));
  const paths = chatPaths(chatId);
  await mkdir(paths.mediaTmpDir, { recursive: true });
  const outputPath = path.join(paths.mediaTmpDir, `whatsapp-profile-${crypto.randomUUID()}.jpg`);
  const filter = `crop=iw/${zoom}:ih/${zoom}:(iw-iw/${zoom})*${focusX}:(ih-ih/${zoom})*${focusY},scale=1024:1024`;
  await new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", "-i", sourcePath, "-vf", filter, "-q:v", "2", outputPath], (error) => error ? reject(error) : resolve());
  });
  return { path: outputPath, generated: true };
}

async function sendOne(chatId, to, message, artifact = null, args = {}) {
  return submitChatJob(chatId, {
    type: "send",
    to,
    message,
    mediaPath: artifact?.path || "",
    readyTimeoutMs: number(config.READY_TIMEOUT_MS, 120000),
    ...sendTimingArgs(args)
  }, {
    timeoutMs: number(config.JOB_TIMEOUT_MS, 120000)
  });
}

async function qrOutput(chatId, status, pid) {
  const paths = chatPaths(chatId);
  if (!status.qr) throw new Error("No active QR code found. Run login first.");
  await QRCode.toFile(paths.qrImageFile, status.qr, { margin: 2, width: 900 });
  return toolOk({
    text: "WhatsApp login QR image generated. Event watch is enabled for this chat. Recommendation: use a dedicated auxiliary number; WhatsApp Web automation can risk Meta restrictions or bans.",
    filePath: paths.qrImageFile,
    fileName: "whatsapp-login-qr.png",
    kind: "image",
    mimeType: "image/png",
    delivery: { method: "photo" },
    json: { pid, ...status }
  });
}

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const mode = String(request.args?.mode || (/qr|login/i.test(String(request.text || "")) ? "qr" : "status")).toLowerCase();

  try {
    const chatId = requestChatId(request);
    await useChatConfig(chatId);

    if (mode === "login") {
      await enableWatch(chatId);
      const runtime = daemonForChat(chatId, { autoStart: true });
      const pid = await runtime.start();
      await submitChatJob(chatId, { type: "ensure" }, {
        timeoutMs: number(request.args?.timeoutMs, 45000),
        requireReady: false
      });
      const status = await waitForLoginSignal(chatId, number(request.args?.timeoutMs, 45000));
      if (status.state === "needs_login" && status.qr) {
        console.log(JSON.stringify(await qrOutput(chatId, status, pid)));
        return;
      }
      console.log(JSON.stringify(toolOk({ text: statusText(chatId, status, pid), json: { pid, ...status } })));
      return;
    }

    if (mode === "status") {
      const { status, pid, alive, stale } = await effectiveChatStatus(chatId, { state: "needs_login", live: false, message: "No WhatsApp session has been started for this chat." });
      if (stale && await isWatchEnabled(chatId)) {
        submitChatJob(chatId, { type: "ensure" }, {
          timeoutMs: number(config.READY_TIMEOUT_MS, 120000),
          requireReady: false
        }).catch(() => {});
      }
      console.log(JSON.stringify(toolOk({ text: statusText(chatId, status, pid), json: { pid, alive, staleRecovered: stale, ...status } })));
      return;
    }

    if (mode === "qr") {
      const status = await readChatStatus(chatId, {});
      const pid = await daemonForChat(chatId).getPid();
      console.log(JSON.stringify(await qrOutput(chatId, status, pid)));
      return;
    }

    if (mode === "send") {
      const message = getMessage(request);
      if (!message && !request.artifact?.path) throw new Error("Message text or media artifact is required");
      const autoWatch = bool(request.args?.watch ?? request.args?.autoWatch, true);
      if (autoWatch) await enableWatch(chatId);
      const result = await sendOne(chatId, request.args?.to || request.args?.recipient, message, request.artifact, request.args);
      const watchNote = autoWatch ? " Watch is enabled for this chat; use wait-reply when you need the immediate answer." : " Watch is disabled by request; run watch or wait-reply to process replies.";
      console.log(JSON.stringify(toolOk({ text: `Message sent to ${result.chatId}.${watchNote}`, json: { ...result, watchEnabled: autoWatch } })));
      return;
    }

    if (mode === "set-profile-picture") {
      if (!request.artifact?.path) throw new Error("An image artifact is required");
      const profileImage = await zoomProfilePicture(chatId, request.artifact.path, request.args);
      const result = await submitChatJob(chatId, {
        type: "setProfilePicture",
        mediaPath: profileImage.path,
        readyTimeoutMs: number(config.READY_TIMEOUT_MS, 120000),
        operationTimeoutMs: number(request.args?.timeoutMs, 45000)
      }, { timeoutMs: number(config.JOB_TIMEOUT_MS, 120000) });
      console.log(JSON.stringify(toolOk({
        text: "WhatsApp profile picture updated.",
        filePath: profileImage.generated ? profileImage.path : undefined,
        fileName: profileImage.generated ? "whatsapp-profile.jpg" : undefined,
        mimeType: profileImage.generated ? "image/jpeg" : undefined,
        kind: profileImage.generated ? "image" : undefined,
        delivery: profileImage.generated ? { method: "photo" } : undefined,
        json: { ...result, zoomApplied: profileImage.generated }
      })));
      return;
    }

    if (mode === "broadcast") {
      const recipients = Array.isArray(request.args?.recipients) ? request.args.recipients : String(request.args?.recipients || "").split(/[\n,;]/).map((item) => item.trim()).filter(Boolean);
      const message = getMessage(request);
      if (!recipients.length) throw new Error("At least one recipient is required");
      if (!message) throw new Error("Message text is required");
      const autoWatch = bool(request.args?.watch ?? request.args?.autoWatch, true);
      if (autoWatch) await enableWatch(chatId);
      const sent = [];
      for (const recipient of recipients) {
        sent.push(await sendOne(chatId, recipient, message, request.artifact, request.args));
        await sleep(number(config.SEND_DELAY_MS, 1200));
      }
      const watchNote = autoWatch ? " Watch is enabled for this chat; use wait-reply when you need an immediate answer from a recipient." : " Watch is disabled by request; run watch or wait-reply to process replies.";
      console.log(JSON.stringify(toolOk({ text: `Sent ${sent.length} WhatsApp messages.${watchNote}`, json: { sent, watchEnabled: autoWatch } })));
      return;
    }

    if (mode === "sync") {
      const result = await submitChatJob(chatId, { type: "sync", limit: number(request.args?.limit, 20) }, { timeoutMs: number(config.JOB_TIMEOUT_MS, 120000) });
      console.log(JSON.stringify(toolOk({ text: `Synced ${result.synced || 0} recent WhatsApp message(s) from ${result.chats || 0} chat(s).`, json: result })));
      return;
    }

    if (mode === "debug-chats") {
      const result = await submitChatJob(chatId, { type: "debugChats", query: request.args?.query, limit: request.args?.limit }, { timeoutMs: number(config.JOB_TIMEOUT_MS, 120000) });
      console.log(JSON.stringify(toolOk({ text: JSON.stringify(result, null, 2), json: { chats: result } })));
      return;
    }

    if (mode === "stickers") {
      const action = request.args?.action || "list";
      if (action === "list") {
        const stickers = (await readStickerIndex(chatId)).slice(-number(request.args?.limit, 20)).reverse();
        console.log(JSON.stringify(toolOk({ text: formatStickerList(stickers), json: { stickers } })));
        return;
      }
      if (action === "tag") {
        const sticker = await tagSticker(chatId, request.args?.id, request.args?.tags || request.args?.tag);
        console.log(JSON.stringify(toolOk({ text: `Tagged sticker ${sticker.id}: ${sticker.tags.join(", ")}`, json: { sticker } })));
        return;
      }
      if (action === "send") {
        const sticker = await selectSticker(chatId, { id: request.args?.id, tag: request.args?.tag });
        const result = await sendOne(chatId, request.args?.to || request.args?.recipient, request.args?.message || "", { path: sticker.filePath }, { ...request.args, asSticker: true });
        await markStickerUsed(chatId, sticker.id);
        console.log(JSON.stringify(toolOk({ text: `Sent sticker ${sticker.id} to ${result.chatId}.`, json: { ...result, sticker } })));
        return;
      }
      throw new Error(`Unknown stickers action: ${action}`);
    }

    if (mode === "delete") {
      const result = await submitChatJob(chatId, {
        type: "delete",
        to: request.args?.to || request.args?.recipient,
        messageId: request.args?.messageId || request.args?.id,
        text: request.args?.text || request.args?.message,
        mediaOnly: request.args?.mediaOnly,
        limit: request.args?.limit,
        everyone: request.args?.everyone,
        readyTimeoutMs: number(config.READY_TIMEOUT_MS, 120000)
      }, { timeoutMs: number(config.JOB_TIMEOUT_MS, 120000) });
      console.log(JSON.stringify(toolOk({ text: `Deleted WhatsApp message ${result.messageId}.`, json: result })));
      return;
    }

    if (mode === "transcribe") {
      const inboxMessage = request.args?.messageId || request.args?.id
        ? (await readInbox(chatId)).find((item) => item.id === (request.args?.messageId || request.args?.id) || item.whatsappMessageId === (request.args?.messageId || request.args?.id))
        : (await selectInboxMessages({ chatId, from: request.args?.from, limit: 1, unreadOnly: false, after: request.args?.after || "" }))[0];
      const messageId = request.args?.messageId || request.args?.id || inboxMessage?.id || "";
      const serializedId = inboxMessage?.rawId?.$1 || inboxMessage?.whatsappMessageId || messageId;
      const result = await submitChatJob(chatId, { type: "transcribe", messageId: serializedId, remote: inboxMessage?.from || request.args?.remote || "", readyTimeoutMs: number(config.READY_TIMEOUT_MS, 120000) }, { timeoutMs: 240000 });
      console.log(JSON.stringify(toolOk({ text: result.transcript, json: result })));
      return;
    }

    if (mode === "inbox") {
      const messages = await selectInboxMessages({ chatId, from: request.args?.from, limit: number(request.args?.limit, 20), unreadOnly: bool(request.args?.unread ?? request.args?.unreadOnly, false), after: request.args?.after || "" });
      if (bool(request.args?.markRead, true)) await markMessagesRead(chatId, messages.map((item) => item.id));
      console.log(JSON.stringify(toolOk({ text: formatInboxMessages(messages), json: { messages } })));
      return;
    }

    if (mode === "react") {
      const messageId = request.args?.messageId || request.args?.id || await latestInboxMessageId({ chatId, from: request.args?.from, after: request.args?.after || "" });
      const emoji = request.args?.emoji ?? request.args?.reaction ?? request.text ?? "👀";
      const result = await submitChatJob(chatId, { ...request.args, type: "react", messageId, emoji, readyTimeoutMs: number(config.READY_TIMEOUT_MS, 120000) }, { timeoutMs: number(config.JOB_TIMEOUT_MS, 120000) });
      console.log(JSON.stringify(toolOk({ text: `Reacted ${result.emoji} to ${result.messageId}.`, json: result })));
      return;
    }

    if (mode === "reactions") {
      const messageId = request.args?.messageId || request.args?.id || await latestInboxMessageId({ chatId, from: request.args?.from, after: request.args?.after || "" });
      const result = await submitChatJob(chatId, { type: "reactions", messageId, readyTimeoutMs: number(config.READY_TIMEOUT_MS, 120000) }, { timeoutMs: number(config.JOB_TIMEOUT_MS, 120000) });
      console.log(JSON.stringify(toolOk({ text: result.reactions?.length ? `Reactions: ${formatReactions(result.reactions)}` : "No reactions found.", json: result })));
      return;
    }

    if (mode === "wait-reply") {
      await submitChatJob(chatId, { type: "ensure" }, { timeoutMs: number(config.READY_TIMEOUT_MS, 120000) });
      const message = await waitForInboxMessage({ chatId, from: request.args?.from, unreadOnly: bool(request.args?.unread ?? request.args?.unreadOnly, true), after: request.args?.after || new Date().toISOString(), timeoutMs: number(request.args?.timeoutMs, 60000) });
      if (bool(request.args?.markRead, true)) await markMessagesRead(chatId, [message.id]);
      console.log(JSON.stringify(toolOk({ text: formatInboxMessages([message]), json: { message } })));
      return;
    }

    if (mode === "watch") {
      await enableWatch(chatId);
      await submitChatJob(chatId, { type: "ensure" }, {
        timeoutMs: number(config.READY_TIMEOUT_MS, 120000),
        requireReady: false
      });
      console.log(JSON.stringify(toolOk({ text: "WhatsApp event-driven processing enabled for this chat. Arisa will only run when a new WhatsApp message arrives.", json: { enabled: true, chatId: Number(chatId) } })));
      return;
    }

    if (mode === "unwatch") {
      await writeJson(watchFileForChat(chatId), { enabled: false, chatId: Number(chatId), updatedAt: new Date().toISOString() });
      await setDaemonAutoStart(chatId, false);
      console.log(JSON.stringify(toolOk({ text: "WhatsApp event-driven processing disabled for this chat.", json: { enabled: false, chatId: Number(chatId) } })));
      return;
    }

    if (mode === "logout") {
      await writeJson(watchFileForChat(chatId), { enabled: false, chatId: Number(chatId), updatedAt: new Date().toISOString() });
      const result = await submitChatJob(chatId, { type: "logout" }, {
        timeoutMs: number(config.JOB_TIMEOUT_MS, 120000),
        requireReady: false
      });
      await setDaemonAutoStart(chatId, false);
      console.log(JSON.stringify(toolOk({ text: "WhatsApp session removed for this chat.", json: result })));
      return;
    }

    throw new Error(`Unknown mode: ${mode}`);
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
  }
}

const args = process.argv.slice(2);
if (args[0] === "daemon") await runDaemon();
else if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
else if (args[0] === "run") await run(args[args.indexOf("--request-file") + 1]);
else printHelp();
