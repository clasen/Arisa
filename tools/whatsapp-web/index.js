import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
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
const { isProcessAlive, readJson, writeJson } = await importCore("core/tools/daemon-processes.js");
const { chatsDir, getChatToolStateDir, tasksFile } = await importCore("runtime/paths.js");

const { Client, LocalAuth, MessageMedia } = pkg;
const toolName = "whatsapp-web";
const config = await loadToolConfig(toolName, defaults);
const daemon = createDaemonRuntime({ toolName, entryPath: new URL(import.meta.url).pathname, beforeStart: cleanupAllBrowserLocks });
const stateRoot = daemon.paths.root;
const chatSessionsRoot = path.join(stateRoot, "chats");
const legacySessionDir = path.join(stateRoot, "session");
const artifactStore = new ArtifactStore();

function printHelp() {
  console.log(`whatsapp-web

Usage:
  node index.js --help
  node index.js run --request-file <json>

Modes:
  login      Start this chat's WhatsApp session, enable watch, and return a QR code when needed.
  status     Show this chat's WhatsApp session status.
  send       Send one WhatsApp message from this chat's WhatsApp session. Enables watch by default.
  broadcast  Send one message to multiple recipients from this chat's session. Enables watch by default.
  inbox      Read/process received WhatsApp replies from this chat's local inbox.
  wait-reply Wait for a reply from an optional recipient after sending.
  watch      Keep this chat's WhatsApp session live and process incoming messages.
  unwatch    Disable event-driven processing for this chat.
  qr         Generate a PNG image from this chat's latest login QR.
  logout     Stop and remove only this chat's local WhatsApp session.

Examples:
  { "chatId": "879964957", "args": { "mode": "login" } }
  { "chatId": "879964957", "args": { "mode": "send", "to": "+5491112345678", "message": "Hello" } }
  { "chatId": "879964957", "args": { "mode": "wait-reply", "from": "+5491112345678" } }
  { "chatId": "879964957", "args": { "mode": "watch" } }

Recommended workflow:
  login once -> keep watch enabled -> send -> wait-reply when the agent needs the immediate answer.
  If WhatsApp is active, watch should stay enabled so replies are processed automatically.

Per-chat sessions: ${chatSessionsRoot}/<chatId>/session
Legacy global session ignored: ${legacySessionDir}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const root = path.join(chatSessionsRoot, normalizeChatId(chatId));
  const commandsDir = path.join(root, "commands");
  return {
    root,
    commandsDir,
    sessionDir: path.join(root, "session"),
    statusFile: path.join(root, "status.json"),
    qrImageFile: path.join(root, "whatsapp-login-qr.png"),
    mediaTmpDir: path.join(root, "media-tmp"),
    webCacheDir: path.join(root, "web-cache"),
    lockFile: path.join(root, "lock")
  };
}

async function ensureToolState() {
  await daemon.ensure();
  await mkdir(chatSessionsRoot, { recursive: true });
}

async function ensureChatState(paths) {
  await mkdir(paths.commandsDir, { recursive: true });
}

function jobPaths(paths, id) {
  return {
    request: path.join(paths.commandsDir, `${id}.request.json`),
    processing: path.join(paths.commandsDir, `${id}.processing.json`),
    result: path.join(paths.commandsDir, `${id}.result.json`)
  };
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

async function submitChatJob(chatId, payload, { timeoutMs = 180000 } = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  const paths = chatPaths(normalizedChatId);
  await daemon.start();
  await ensureChatState(paths);

  const id = crypto.randomUUID();
  const files = jobPaths(paths, id);
  await writeJson(files.request, { id, chatId: normalizedChatId, ...payload });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await readJson(files.result, null);
    if (result) {
      await unlink(files.result).catch(() => {});
      if (!result.ok) throw new Error(result.error || `${toolName} job failed`);
      return result.output || {};
    }
    await sleep(250);
  }
  throw new Error(`${toolName} job timed out after ${timeoutMs}ms`);
}

async function listSessionChatIds() {
  const entries = await readdir(chatSessionsRoot, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).filter((entry) => /^-?\d+$/.test(entry)).sort();
}

async function claimNextChatJob() {
  for (const chatId of await listSessionChatIds()) {
    const paths = chatPaths(chatId);
    const files = await readdir(paths.commandsDir).catch(() => []);
    for (const file of files.filter((item) => item.endsWith(".request.json")).sort()) {
      const id = file.replace(/\.request\.json$/, "");
      const item = jobPaths(paths, id);
      try {
        await rename(item.request, item.processing);
        return { id, chatId, paths, ...item, payload: await readJson(item.processing, null) };
      } catch {}
    }
  }
  return null;
}

async function completeJob(job, output) {
  await writeJson(job.result, { ok: true, output });
  await unlink(job.processing).catch(() => {});
}

async function failJob(job, error) {
  await writeJson(job.result, { ok: false, error: error?.message || String(error) });
  await unlink(job.processing).catch(() => {});
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

async function cleanupBrowserLocks(paths) {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    await rm(path.join(paths.sessionDir, "session", name), { force: true }).catch(() => {});
  }
}

async function cleanupAllBrowserLocks() {
  for (const chatId of await listSessionChatIds()) {
    await cleanupBrowserLocks(chatPaths(chatId));
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

function formatInboxMessages(messages) {
  if (!messages.length) return "No WhatsApp replies found.";
  return messages.map((item, index) => [
    `${index + 1}. From: ${item.fromName || item.from}`,
    item.fromPhone ? `Phone: ${item.fromPhone}` : null,
    `At: ${item.receivedAt}`,
    `Text: ${item.body || "[non-text message]"}`
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

async function markMessagesRead(chatId, ids) {
  if (!ids.length) return;
  await updateInboxMessages(chatId, (messages) => messages.map((item) => ids.includes(item.id) ? { ...item, read: true } : item));
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
}

async function readWatchConfigs() {
  const entries = await readdir(chatsDir, { withFileTypes: true }).catch(() => []);
  const watches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^-?\d+$/.test(entry.name)) continue;
    const chatId = entry.name;
    const watch = await readWatchConfig(chatId);
    if (watch.enabled) watches.push({ ...watch, chatId: Number(watch.chatId || chatId) });
  }
  return watches;
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

function buildIncomingMessagePrompt(message, artifact) {
  return [
    "System event: Incoming WhatsApp message.",
    `from: ${message.fromName || message.from}`,
    message.fromPhone ? `fromPhone: ${message.fromPhone}` : null,
    `whatsappId: ${message.from}`,
    `receivedAt: ${message.receivedAt}`,
    `type: ${message.type}`,
    `text: ${message.body || "[non-text message]"}`,
    artifact ? `artifactId: ${artifact.id}` : null,
    artifact ? `mimeType: ${artifact.mimeType}` : null,
    artifact ? `kind: ${artifact.kind}` : null,
    "Treat this as a new WhatsApp reply that Arisa must reason about.",
    "If you need to reply by WhatsApp, use the whatsapp-web tool."
  ].filter(Boolean).join("\n");
}

async function enqueueArisaTaskForIncomingMessage(chatId, message, artifact = null) {
  const numericChatId = Number(chatId);
  const tasks = await readTasks();
  if (tasks.some((task) => task.source?.toolName === toolName && task.source?.chatId === numericChatId && task.source?.messageId === message.id)) return;
  tasks.push({
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    kind: "agent_task",
    runAt: new Date().toISOString(),
    payload: { chatId: numericChatId, prompt: buildIncomingMessagePrompt(message, artifact), artifactId: artifact?.id || "" },
    recurrence: null,
    source: { type: "tool", toolName, chatId: numericChatId, messageId: message.id }
  });
  await writeTasks(tasks);
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
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  };
  if (config.CHROME_EXECUTABLE_PATH && existsSync(config.CHROME_EXECUTABLE_PATH)) puppeteer.executablePath = config.CHROME_EXECUTABLE_PATH;
  return new Client({
    authStrategy: new LocalAuth({ dataPath: paths.sessionDir }),
    puppeteer,
    webVersionCache: { type: "local", path: paths.webCacheDir }
  });
}

function mediaKind(mimeType = "", messageType = "") {
  if (mimeType.startsWith("audio/") || messageType === "ptt") return "audio";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function mediaExtension(mimeType = "") {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  const map = { "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "image/jpeg": "jpg", "image/png": "png", "video/mp4": "mp4" };
  return map[base] || "bin";
}

async function storeIncomingMediaArtifact(message, chatId) {
  if (!message.hasMedia) return null;
  let media = null;
  try { media = await message.downloadMedia(); } catch { return null; }
  if (!media?.data || !media?.mimetype) return null;

  const paths = chatPaths(chatId);
  const mimeType = media.mimetype.split(";")[0].trim();
  const kind = mediaKind(mimeType, message.type);
  const fileName = media.filename || `whatsapp-${message.id?._serialized || Date.now()}.${mediaExtension(mimeType)}`;
  await mkdir(paths.mediaTmpDir, { recursive: true });
  const tmpPath = path.join(paths.mediaTmpDir, `${crypto.randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  await writeFile(tmpPath, Buffer.from(media.data, "base64"));
  try {
    return await artifactStore.forChat(chatId).createFromFile({
      originalPath: tmpPath,
      fileName,
      kind,
      mimeType,
      source: { type: "tool", toolName, whatsappMessageId: message.id?._serialized || "" },
      metadata: { whatsappFrom: message.from, whatsappType: message.type }
    });
  } finally {
    await unlink(tmpPath).catch(() => {});
    await rmdir(paths.mediaTmpDir).catch(() => {});
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
  try { contact = await message.getContact(); } catch {}
  const inboxMessage = {
    id: message.id?._serialized || `${message.from}-${message.timestamp}-${Date.now()}`,
    from: message.from,
    fromPhone: String(message.from || "").replace(/@c\.us$/, ""),
    fromName: compact(contact?.pushname || contact?.name || contact?.number || ""),
    body: message.body || "",
    type: message.type || "unknown",
    timestamp: message.timestamp || Math.floor(Date.now() / 1000),
    receivedAt: new Date((message.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    read: false
  };

  if (!(await appendInboxMessage(ownerChatId, inboxMessage))) return;
  if (!(await isWatchEnabled(ownerChatId))) return;

  const artifact = await storeIncomingMediaArtifact(message, ownerChatId);
  await enqueueArisaTaskForIncomingMessage(ownerChatId, inboxMessage, artifact);
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
      loginNotificationPending: false
    };
    this.sessions.set(normalizedChatId, record);

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
    client.on("auth_failure", async (message) => {
      this.sessions.delete(normalizedChatId);
      await writeChatStatus(normalizedChatId, { state: "expired", live: false, pid: process.pid, message: `Authentication failed: ${message}` });
    });
    client.on("disconnected", async (reason) => {
      if (record.closingReason === "idle" || record.closingReason === "logout") return;
      this.sessions.delete(normalizedChatId);
      await writeChatStatus(normalizedChatId, { state: "expired", live: false, pid: process.pid, message: `Disconnected: ${reason}` });
    });

    record.initializing = client.initialize().catch(async (error) => {
      this.sessions.delete(normalizedChatId);
      await writeChatStatus(normalizedChatId, { state: "failed", live: false, pid: process.pid, message: error.message || String(error) });
      try { await client.destroy(); } catch {}
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

  async send(chatId, job) {
    const record = await this.ensureClient(chatId);
    await this.waitReady(chatId, number(job.readyTimeoutMs, number(config.READY_TIMEOUT_MS, 120000)));
    record.lastActivity = Date.now();
    const whatsappChatId = normalizeRecipient(job.to);
    if (job.mediaPath) {
      const media = MessageMedia.fromFilePath(job.mediaPath);
      await record.client.sendMessage(whatsappChatId, media, { caption: job.message || "" });
    } else {
      await record.client.sendMessage(whatsappChatId, job.message);
    }
    record.lastActivity = Date.now();
    return { chatId: whatsappChatId, sessionChatId: normalizeChatId(chatId) };
  }

  async logout(chatId) {
    const normalizedChatId = normalizeChatId(chatId);
    const record = this.sessions.get(normalizedChatId);
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

  async shutdownIdleClients() {
    if (this.idleShutdownMs <= 0) return;
    for (const [chatId, record] of this.sessions) {
      if (await isWatchEnabled(chatId)) continue;
      if (Date.now() - record.lastActivity < this.idleShutdownMs) continue;
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

  async ensureWatchedClients() {
    for (const watch of await readWatchConfigs()) {
      await this.ensureClient(String(watch.chatId));
    }
  }
}

async function processJob(manager, job) {
  if (!job?.payload?.type) throw new Error("Invalid WhatsApp command");
  const chatId = normalizeChatId(job.payload.chatId || job.chatId);
  if (job.payload.type === "ensure") {
    await withChatLock(job.paths, () => manager.ensureClient(chatId));
    return readChatStatus(chatId, {});
  }
  if (job.payload.type === "send") {
    return manager.send(chatId, job.payload);
  }
  if (job.payload.type === "logout") {
    return withChatLock(job.paths, () => manager.logout(chatId));
  }
  throw new Error(`Unknown command type: ${job.payload.type}`);
}

async function runDaemon() {
  await ensureToolState();
  await daemon.writeStatus({ state: "ready", pid: process.pid, message: "WhatsApp multiplex daemon is ready." });
  const manager = new SessionManager();
  let processing = false;

  manager.ensureWatchedClients().catch((error) => {
    daemon.writeStatus({ state: "error", pid: process.pid, message: error?.message || String(error) }).catch(() => {});
  });

  setInterval(async () => {
    if (processing) return;
    processing = true;
    try {
      const job = await claimNextChatJob();
      if (job) {
        try {
          await completeJob(job, await processJob(manager, job));
        } catch (error) {
          await failJob(job, error);
        }
      }
    } catch (error) {
      await daemon.writeStatus({ state: "error", pid: process.pid, message: error?.message || String(error) });
    } finally {
      processing = false;
    }
  }, 250);

  setInterval(() => {
    manager.ensureWatchedClients().catch((error) => {
      daemon.writeStatus({ state: "error", pid: process.pid, message: error?.message || String(error) }).catch(() => {});
    });
  }, 10000);

  setInterval(() => {
    manager.shutdownIdleClients().catch((error) => {
      daemon.writeStatus({ state: "error", pid: process.pid, message: error?.message || String(error) }).catch(() => {});
    });
  }, 30000);
}

function getMessage(request) {
  return String(request.args?.message || request.text || request.artifact?.text || "").trim();
}

async function sendOne(chatId, to, message, artifact = null) {
  return submitChatJob(chatId, {
    type: "send",
    to,
    message,
    mediaPath: artifact?.path || "",
    readyTimeoutMs: number(config.READY_TIMEOUT_MS, 120000)
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

    if (mode === "login") {
      await enableWatch(chatId);
      const pid = await daemon.start();
      await submitChatJob(chatId, { type: "ensure" }, { timeoutMs: number(request.args?.timeoutMs, 45000) });
      const status = await waitForLoginSignal(chatId, number(request.args?.timeoutMs, 45000));
      if (status.state === "needs_login" && status.qr) {
        console.log(JSON.stringify(await qrOutput(chatId, status, pid)));
        return;
      }
      console.log(JSON.stringify(toolOk({ text: statusText(chatId, status, pid), json: { pid, ...status } })));
      return;
    }

    if (mode === "status") {
      const status = await readChatStatus(chatId, { state: "needs_login", live: false, message: "No WhatsApp session has been started for this chat." });
      const pid = await daemon.getPid();
      console.log(JSON.stringify(toolOk({ text: statusText(chatId, status, pid), json: { pid, alive: isProcessAlive(pid), ...status } })));
      return;
    }

    if (mode === "qr") {
      const status = await readChatStatus(chatId, {});
      const pid = await daemon.getPid();
      console.log(JSON.stringify(await qrOutput(chatId, status, pid)));
      return;
    }

    if (mode === "send") {
      const message = getMessage(request);
      if (!message && !request.artifact?.path) throw new Error("Message text or media artifact is required");
      const autoWatch = bool(request.args?.watch ?? request.args?.autoWatch, true);
      if (autoWatch) await enableWatch(chatId);
      const result = await sendOne(chatId, request.args?.to || request.args?.recipient, message, request.artifact);
      const watchNote = autoWatch ? " Watch is enabled for this chat; use wait-reply when you need the immediate answer." : " Watch is disabled by request; run watch or wait-reply to process replies.";
      console.log(JSON.stringify(toolOk({ text: `Message sent to ${result.chatId}.${watchNote}`, json: { ...result, watchEnabled: autoWatch } })));
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
        sent.push(await sendOne(chatId, recipient, message, request.artifact));
        await sleep(number(config.SEND_DELAY_MS, 1200));
      }
      const watchNote = autoWatch ? " Watch is enabled for this chat; use wait-reply when you need an immediate answer from a recipient." : " Watch is disabled by request; run watch or wait-reply to process replies.";
      console.log(JSON.stringify(toolOk({ text: `Sent ${sent.length} WhatsApp messages.${watchNote}`, json: { sent, watchEnabled: autoWatch } })));
      return;
    }

    if (mode === "inbox") {
      const messages = await selectInboxMessages({ chatId, from: request.args?.from, limit: number(request.args?.limit, 20), unreadOnly: bool(request.args?.unread ?? request.args?.unreadOnly, false), after: request.args?.after || "" });
      if (bool(request.args?.markRead, true)) await markMessagesRead(chatId, messages.map((item) => item.id));
      console.log(JSON.stringify(toolOk({ text: formatInboxMessages(messages), json: { messages } })));
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
      await submitChatJob(chatId, { type: "ensure" }, { timeoutMs: number(config.READY_TIMEOUT_MS, 120000) });
      console.log(JSON.stringify(toolOk({ text: "WhatsApp event-driven processing enabled for this chat. Arisa will only run when a new WhatsApp message arrives.", json: { enabled: true, chatId: Number(chatId) } })));
      return;
    }

    if (mode === "unwatch") {
      await writeJson(watchFileForChat(chatId), { enabled: false, chatId: Number(chatId), updatedAt: new Date().toISOString() });
      console.log(JSON.stringify(toolOk({ text: "WhatsApp event-driven processing disabled for this chat.", json: { enabled: false, chatId: Number(chatId) } })));
      return;
    }

    if (mode === "logout") {
      const result = await submitChatJob(chatId, { type: "logout" }, { timeoutMs: number(config.JOB_TIMEOUT_MS, 120000) });
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
