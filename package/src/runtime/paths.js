import { mkdir } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const arisaPackageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const arisaHomeDir = process.env.ARISA_HOME
  ? path.resolve(process.env.ARISA_HOME)
  : path.join(os.homedir(), ".arisa");
export const stateDir = path.join(arisaHomeDir, "state");
export const configFile = path.join(stateDir, "config.json");
export const piAuthFile = path.join(stateDir, "pi-auth.json");
export const primeStateDir = path.join(stateDir, "prime-agent");
export const primeAuthFile = path.join(primeStateDir, "auth.json");
export function createPrimeDaemonSocketPath({ homeDir = arisaHomeDir, platform = process.platform } = {}) {
  if (platform === "win32") {
    const suffix = crypto.createHash("sha256").update(homeDir).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\arisa-prime-${suffix}`;
  }
  return path.join(homeDir, "state", "prime-agent", "daemon.sock");
}

export const primeDaemonSocketFile = createPrimeDaemonSocketPath();
export const primeSupervisorRegistryDir = path.join(primeStateDir, "supervisor-owners");
const primeDaemonUserSuffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
const legacyPrimeDaemonDir = path.join(os.tmpdir(), `prime-agent-${primeDaemonUserSuffix}`);
export const legacyPrimeDaemonSocketFile = process.platform === "win32"
  ? "\\\\.\\pipe\\prime-agent-daemon"
  : path.join(legacyPrimeDaemonDir, "daemon.sock");
export const legacyPrimeSupervisorRegistryDir = path.join(
  legacyPrimeDaemonDir,
  "supervisor-owners"
);
export const servicePidFile = path.join(stateDir, "arisa.pid");
export const serviceLogFile = path.join(stateDir, "arisa.log");
export const harnessTransitionsFile = path.join(stateDir, "harness-transitions.jsonl");
export function createIpcSocketPath({ homeDir = arisaHomeDir, platform = process.platform } = {}) {
  if (platform === "win32") {
    const suffix = crypto.createHash("sha256").update(homeDir).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\arisa-${suffix}`;
  }
  return path.join(homeDir, "state", "arisa.sock");
}

export const arisaIpcSocketFile = createIpcSocketPath();
export const tasksFile = path.join(stateDir, "tasks.json");
export const toolsDir = path.join(arisaHomeDir, "tools");
export const chatsDir = path.join(arisaHomeDir, "chats");
export const toolStateDir = path.join(stateDir, "tools");
export const runtimesDir = path.join(arisaHomeDir, "runtimes");
export const primeRuntimesDir = path.join(runtimesDir, "prime-agent");

export function getChatDir(chatId) {
  return path.join(chatsDir, String(chatId));
}

export function getChatArtifactsDir(chatId) {
  return path.join(getChatDir(chatId), "artifacts");
}

export function getChatArtifactsIndexFile(chatId) {
  return path.join(getChatDir(chatId), "state", "artifacts.json");
}

export function getChatConversationHistoryFile(chatId) {
  return path.join(getChatDir(chatId), "state", "conversation.jsonl");
}

export function getChatToolStateDir(chatId, toolName) {
  return path.join(getChatDir(chatId), "state", "tools", toolName);
}

export function normalizeDaemonScope(scope = { type: "global" }) {
  if (!scope || scope === "global" || scope.type === "global") {
    return { type: "global" };
  }
  if (scope === "chat") {
    throw new Error("chat daemon scope requires chatId");
  }
  if (scope.type !== "chat") {
    throw new Error(`Unsupported daemon scope: ${scope.type || scope}`);
  }
  const chatId = String(scope.chatId ?? "").trim();
  if (!/^-?\d+$/.test(chatId)) {
    throw new Error(`Invalid chat daemon scope: ${chatId || "missing chatId"}`);
  }
  return { type: "chat", chatId };
}

export function getDaemonInstanceId(scope = { type: "global" }) {
  const normalized = normalizeDaemonScope(scope);
  return normalized.type === "global" ? "global" : `chat:${normalized.chatId}`;
}

export function getDaemonInstanceDir(toolName, scope = { type: "global" }) {
  const normalized = normalizeDaemonScope(scope);
  return normalized.type === "global"
    ? getToolStateDir(toolName)
    : path.join(getChatToolStateDir(normalized.chatId, toolName), "daemon");
}

export function getChatPiSessionsDir(chatId, sessionRevision = 0) {
  if (!Number.isSafeInteger(sessionRevision) || sessionRevision < 0) {
    throw new Error(`Invalid Pi session revision: ${sessionRevision}`);
  }
  const sessionsDir = path.join(getChatDir(chatId), "state", "pi-sessions");
  return sessionRevision === 0
    ? sessionsDir
    : path.join(sessionsDir, String(sessionRevision));
}

export function getChatPrimeSessionsDir(chatId, sessionRevision = 0) {
  if (!Number.isSafeInteger(sessionRevision) || sessionRevision < 0) {
    throw new Error(`Invalid Prime session revision: ${sessionRevision}`);
  }
  const sessionsDir = path.join(getChatDir(chatId), "state", "prime-sessions");
  return path.join(sessionsDir, String(sessionRevision));
}

export function getChatPrimeHandoffFile(chatId, sessionRevision = 0) {
  return path.join(getChatPrimeSessionsDir(chatId, sessionRevision), "arisa-handoff.txt");
}

export function getToolDir(toolName) {
  return path.join(toolsDir, toolName);
}

export function getToolConfigPath(toolName) {
  return path.join(getToolDir(toolName), "config.js");
}

export function getChatConfigDir(chatId) {
  return path.join(getChatDir(chatId), "config");
}

export function getChatTmpDir(chatId) {
  return path.join(getChatDir(chatId), "tmp");
}

export function getChatToolConfigPath(chatId, toolName) {
  return path.join(getChatConfigDir(chatId), "tools", toolName, "config.js");
}

export function getToolStateDir(toolName) {
  return path.join(toolStateDir, toolName);
}

export function getToolTmpDir(toolName) {
  return path.join(getToolStateDir(toolName), "tmp");
}

export function getChatToolTmpDir(chatId, toolName) {
  return path.join(getChatTmpDir(chatId), "tools", toolName);
}

export async function ensureArisaHome() {
  await mkdir(stateDir, { recursive: true });
  await mkdir(primeStateDir, { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  await mkdir(chatsDir, { recursive: true });
  await mkdir(primeRuntimesDir, { recursive: true });
}
