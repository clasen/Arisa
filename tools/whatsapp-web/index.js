import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import pkg from "whatsapp-web.js";
import defaults from "./config.js";
import { loadToolConfig } from "../../src/core/tools/tool-config.js";
import { toolError, toolOk } from "../../src/core/tools/tool-result.js";
import { ArtifactStore } from "../../src/core/artifacts/artifact-store.js";
import { createDaemonRuntime, isProcessAlive, readJson, writeJson } from "../../src/core/tools/daemon-runtime.js";
import { chatsDir, getChatToolStateDir, tasksFile } from "../../src/runtime/paths.js";

const { Client, LocalAuth, MessageMedia } = pkg;
const toolName = "whatsapp-web";
const config = await loadToolConfig(toolName, defaults);
const daemon = createDaemonRuntime({ toolName, entryPath: new URL(import.meta.url).pathname, beforeStart: cleanupBrowserLocks });
const stateRoot = daemon.paths.root;
const sessionDir = path.join(stateRoot, "session");
const qrImageFile = path.join(stateRoot, "whatsapp-login-qr.png");
const mediaTmpDir = path.join(stateRoot, "media-tmp");
const webCacheDir = path.join(stateRoot, "web-cache");
const artifactStore = new ArtifactStore();

function printHelp() {
  console.log(`whatsapp-web\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nModes:\n  login      Start the daemon and return a QR code when needed.\n  status     Show daemon/session status.\n  send       Send one WhatsApp message.\n  broadcast  Send one message to multiple recipients.\n  inbox      Read/process received WhatsApp replies from the local inbox.\n  wait-reply Wait for a reply from an optional recipient.\n  watch      Enable event-driven processing when new WhatsApp messages arrive.\n  unwatch    Disable event-driven processing.\n  qr         Generate a PNG image from the latest login QR.\n  logout     Stop daemon and remove the local WhatsApp session.\n\nExamples:\n  { "args": { "mode": "login" } }\n  { "args": { "mode": "send", "to": "+5491112345678", "message": "Hello" } }\n  { "args": { "mode": "watch", "chatId": "879964957" } }\n\nSession: ${sessionDir}\n`);
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

async function ensureState() {
  await daemon.ensure();
}

async function cleanupBrowserLocks() {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    await rm(path.join(sessionDir, "session", name), { force: true }).catch(() => {});
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`No WhatsApp reply received within ${timeoutMs}ms`);
}

function watchFileForChat(chatId) {
  return path.join(getChatToolStateDir(chatId, toolName), "watch.json");
}

async function readWatchConfigs() {
  const entries = await readdir(chatsDir, { withFileTypes: true }).catch(() => []);
  const watches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const chatId = entry.name;
    const watch = await readJson(watchFileForChat(chatId), { enabled: false });
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

async function enqueueArisaTaskForIncomingMessage(watch, message, artifact = null) {
  const tasks = await readTasks();
  if (tasks.some((task) => task.source?.toolName === toolName && task.source?.chatId === Number(watch.chatId) && task.source?.messageId === message.id)) return;
  tasks.push({
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    kind: "agent_task",
    runAt: new Date().toISOString(),
    payload: { chatId: Number(watch.chatId), prompt: buildIncomingMessagePrompt(message, artifact), artifactId: artifact?.id || "" },
    recurrence: null,
    source: { type: "tool", toolName, chatId: Number(watch.chatId), messageId: message.id }
  });
  await writeTasks(tasks);
}

function renderQr(qr) {
  let rendered = "";
  qrcodeTerminal.generate(qr, { small: true }, (text) => { rendered = text; });
  return rendered;
}

function makeClient() {
  const puppeteer = {
    headless: bool(config.HEADLESS, true) ? "new" : false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  };
  if (config.CHROME_EXECUTABLE_PATH && existsSync(config.CHROME_EXECUTABLE_PATH)) puppeteer.executablePath = config.CHROME_EXECUTABLE_PATH;
  return new Client({
    authStrategy: new LocalAuth({ dataPath: sessionDir }),
    puppeteer,
    webVersionCache: { type: "local", path: webCacheDir }
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

async function storeIncomingMediaArtifact(message, watch) {
  if (!watch.enabled || !watch.chatId || !message.hasMedia) return null;
  let media = null;
  try { media = await message.downloadMedia(); } catch { return null; }
  if (!media?.data || !media?.mimetype) return null;

  const mimeType = media.mimetype.split(";")[0].trim();
  const kind = mediaKind(mimeType, message.type);
  const fileName = media.filename || `whatsapp-${message.id?._serialized || Date.now()}.${mediaExtension(mimeType)}`;
  await mkdir(mediaTmpDir, { recursive: true });
  const tmpPath = path.join(mediaTmpDir, `${crypto.randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  await writeFile(tmpPath, Buffer.from(media.data, "base64"));
  try {
    return await artifactStore.forChat(watch.chatId).createFromFile({
      originalPath: tmpPath,
      fileName,
      kind,
      mimeType,
      source: { type: "tool", toolName, whatsappMessageId: message.id?._serialized || "" },
      metadata: { whatsappFrom: message.from, whatsappType: message.type }
    });
  } finally {
    await unlink(tmpPath).catch(() => {});
    await rmdir(mediaTmpDir).catch(() => {});
  }
}

async function captureIncomingMessage(message) {
  if (message.fromMe) {
    await daemon.writeStatus({ state: "ready", message: "WhatsApp is ready." });
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
  const watches = await readWatchConfigs();
  for (const watch of watches) {
    if (!(await appendInboxMessage(watch.chatId, inboxMessage))) continue;
    const artifact = await storeIncomingMediaArtifact(message, watch);
    await enqueueArisaTaskForIncomingMessage(watch, inboxMessage, artifact);
  }
}

async function processJob(client, job) {
  if (job.type !== "send") throw new Error(`Unknown command type: ${job.type}`);
  const chatId = normalizeRecipient(job.to);
  if (job.mediaPath) {
    const media = MessageMedia.fromFilePath(job.mediaPath);
    await client.sendMessage(chatId, media, { caption: job.message || "" });
  } else {
    await client.sendMessage(chatId, job.message);
  }
  return { chatId };
}

async function runDaemon() {
  await ensureState();
  await daemon.writeStatus({ state: "starting", pid: process.pid, message: "Starting WhatsApp Web client" });
  const client = makeClient();

  client.on("qr", async (qr) => daemon.writeStatus({ state: "qr", qr, qrText: renderQr(qr), message: "Scan this QR code with WhatsApp > Linked devices." }));
  client.on("authenticated", async () => daemon.writeStatus({ state: "authenticated", message: "Authenticated, waiting for WhatsApp to be ready." }));
  client.on("ready", async () => {
    await daemon.writeStatus({ state: "ready", message: "WhatsApp is ready." });
    await daemon.workLoop({ processJob: (job) => processJob(client, job) });
  });
  client.on("message", async (message) => {
    try { await captureIncomingMessage(message); }
    catch (error) { await daemon.writeStatus({ state: "ready", message: `WhatsApp is ready. Inbox warning: ${error.message || error}` }); }
  });
  client.on("message_create", async (message) => {
    if (message.fromMe) await daemon.writeStatus({ state: "ready", message: "WhatsApp is ready." });
  });
  client.on("auth_failure", async (message) => daemon.writeStatus({ state: "error", message: `Authentication failed: ${message}` }));
  client.on("disconnected", async (reason) => daemon.writeStatus({ state: "disconnected", message: `Disconnected: ${reason}` }));

  try { await client.initialize(); }
  catch (error) { await daemon.writeStatus({ state: "error", message: error.message || String(error) }); }
}

async function waitForLoginSignal(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await readJson(daemon.paths.statusFile, {});
    if (["ready", "qr", "authenticated", "error"].includes(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return readJson(daemon.paths.statusFile, { state: "starting" });
}

function getMessage(request) {
  return String(request.args?.message || request.text || request.artifact?.text || "").trim();
}

async function sendOne(to, message, artifact = null) {
  return daemon.submit({ type: "send", to, message, mediaPath: artifact?.path || "" }, {
    timeoutMs: number(config.JOB_TIMEOUT_MS, 120000),
    readyTimeoutMs: number(config.READY_TIMEOUT_MS, 120000)
  });
}

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const mode = String(request.args?.mode || (/qr|login/i.test(String(request.text || "")) ? "qr" : "status")).toLowerCase();
  const requestChatId = request.chatId || request.args?.chatId || request.args?.telegramChatId || request.artifact?.chatId;

  try {
    if (mode === "login") {
      const pid = await daemon.start();
      const status = await waitForLoginSignal(number(request.args?.timeoutMs, 45000));
      if (status.state === "qr" && status.qr) {
        await QRCode.toFile(qrImageFile, status.qr, { margin: 2, width: 900 });
        console.log(JSON.stringify(toolOk({ text: "WhatsApp login QR image generated.", filePath: qrImageFile, fileName: "whatsapp-login-qr.png", kind: "image", mimeType: "image/png", delivery: { method: "document" }, json: { pid, ...status } })));
        return;
      }
      console.log(JSON.stringify(toolOk({ text: `WhatsApp status: ${status.state || "unknown"}\n${status.message || ""}`, json: { pid, ...status } })));
      return;
    }

    if (mode === "status") {
      const status = await readJson(daemon.paths.statusFile, { state: "unknown", message: "No WhatsApp daemon has been started." });
      const pid = await daemon.getPid();
      console.log(JSON.stringify(toolOk({ text: `WhatsApp status: ${status.state}\n${status.message || ""}${pid ? `\nDaemon pid: ${pid}` : ""}`, json: { pid, alive: isProcessAlive(pid), ...status } })));
      return;
    }

    if (mode === "qr") {
      const status = await readJson(daemon.paths.statusFile, {});
      if (!status.qr) throw new Error("No active QR code found. Run login first.");
      await QRCode.toFile(qrImageFile, status.qr, { margin: 2, width: 900 });
      console.log(JSON.stringify(toolOk({ text: "WhatsApp login QR image generated.", filePath: qrImageFile, fileName: "whatsapp-login-qr.png", kind: "image", mimeType: "image/png", delivery: { method: "document" } })));
      return;
    }

    if (mode === "send") {
      const message = getMessage(request);
      if (!message && !request.artifact?.path) throw new Error("Message text or media artifact is required");
      const result = await sendOne(request.args?.to || request.args?.recipient, message, request.artifact);
      console.log(JSON.stringify(toolOk({ text: `Message sent to ${result.chatId}.`, json: result })));
      return;
    }

    if (mode === "broadcast") {
      const recipients = Array.isArray(request.args?.recipients) ? request.args.recipients : String(request.args?.recipients || "").split(/[\n,;]/).map((item) => item.trim()).filter(Boolean);
      const message = getMessage(request);
      if (!recipients.length) throw new Error("At least one recipient is required");
      if (!message) throw new Error("Message text is required");
      const sent = [];
      for (const recipient of recipients) {
        sent.push(await sendOne(recipient, message, request.artifact));
        await new Promise((resolve) => setTimeout(resolve, number(config.SEND_DELAY_MS, 1200)));
      }
      console.log(JSON.stringify(toolOk({ text: `Sent ${sent.length} WhatsApp messages.`, json: { sent } })));
      return;
    }

    if (mode === "inbox") {
      if (!requestChatId) throw new Error("chatId is required for inbox mode");
      const messages = await selectInboxMessages({ chatId: requestChatId, from: request.args?.from, limit: number(request.args?.limit, 20), unreadOnly: bool(request.args?.unread ?? request.args?.unreadOnly, false), after: request.args?.after || "" });
      if (bool(request.args?.markRead, true)) await markMessagesRead(requestChatId, messages.map((item) => item.id));
      console.log(JSON.stringify(toolOk({ text: formatInboxMessages(messages), json: { messages } })));
      return;
    }

    if (mode === "wait-reply") {
      await daemon.start();
      if (!requestChatId) throw new Error("chatId is required for wait-reply mode");
      const message = await waitForInboxMessage({ chatId: requestChatId, from: request.args?.from, unreadOnly: bool(request.args?.unread ?? request.args?.unreadOnly, true), after: request.args?.after || new Date().toISOString(), timeoutMs: number(request.args?.timeoutMs, 60000) });
      if (bool(request.args?.markRead, true)) await markMessagesRead(requestChatId, [message.id]);
      console.log(JSON.stringify(toolOk({ text: formatInboxMessages([message]), json: { message } })));
      return;
    }

    if (mode === "watch") {
      const chatId = request.args?.chatId || request.args?.telegramChatId;
      if (!chatId) throw new Error("chatId is required for event-driven watch mode");
      await writeJson(watchFileForChat(chatId), { enabled: true, chatId: Number(chatId), updatedAt: new Date().toISOString() });
      await daemon.start();
      console.log(JSON.stringify(toolOk({ text: "WhatsApp event-driven processing enabled. Arisa will only run when a new WhatsApp message arrives.", json: { enabled: true, chatId: Number(chatId) } })));
      return;
    }

    if (mode === "unwatch") {
      if (!requestChatId) throw new Error("chatId is required for unwatch mode");
      await writeJson(watchFileForChat(requestChatId), { enabled: false, chatId: Number(requestChatId), updatedAt: new Date().toISOString() });
      console.log(JSON.stringify(toolOk({ text: "WhatsApp event-driven processing disabled.", json: { enabled: false } })));
      return;
    }

    if (mode === "logout") {
      await daemon.stop();
      await rm(sessionDir, { recursive: true, force: true });
      await daemon.writeStatus({ state: "logged_out", message: "Local WhatsApp session removed." });
      console.log(JSON.stringify(toolOk({ text: "WhatsApp session removed." })));
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
