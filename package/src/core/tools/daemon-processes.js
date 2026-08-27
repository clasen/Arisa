import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chatsDir,
  getDaemonInstanceDir,
  getDaemonInstanceId,
  normalizeDaemonScope,
  toolStateDir
} from "../../platform/paths.js";
import { loadDaemonPolicy } from "./daemon-policy.js";

export const DAEMON_STATES = Object.freeze([
  "starting",
  "ready",
  "degraded",
  "unhealthy",
  "restarting",
  "stopped",
  "failed"
]);

export function daemonProcessInvocation(entryPath, {
  platform = process.platform,
  nodePath = process.execPath,
  oomAdjustAvailable = existsSync("/usr/bin/choom")
} = {}) {
  if (platform !== "linux" || !oomAdjustAvailable) {
    return { command: nodePath, args: [entryPath, "daemon"], oomProtected: false };
  }
  return {
    command: "/usr/bin/choom",
    args: ["-n", "500", "--", nodePath, entryPath, "daemon"],
    oomProtected: true
  };
}

function daemonIdentity(toolNameOrOptions, scope) {
  if (typeof toolNameOrOptions === "string") {
    return { toolName: toolNameOrOptions, scope: normalizeDaemonScope(scope) };
  }
  return {
    toolName: toolNameOrOptions.toolName,
    scope: normalizeDaemonScope(toolNameOrOptions.scope)
  };
}

export function daemonPaths(toolNameOrOptions, scope) {
  const identity = daemonIdentity(toolNameOrOptions, scope);
  const root = getDaemonInstanceDir(identity.toolName, identity.scope);
  const localSocket = path.join(root, "daemon.sock");
  return {
    ...identity,
    instanceId: getDaemonInstanceId(identity.scope),
    root,
    commandsDir: path.join(root, "commands"),
    pidFile: path.join(root, "daemon.pid"),
    metaFile: path.join(root, "daemon.meta.json"),
    statusFile: path.join(root, "status.json"),
    logFile: path.join(root, "daemon.log"),
    startLockFile: path.join(root, "daemon.start.lock"),
    socketFile: process.platform === "win32"
      ? `\\\\.\\pipe\\arisa-daemon-${crypto.createHash("sha256").update(root).digest("hex").slice(0, 16)}`
      : Buffer.byteLength(localSocket) <= 96
        ? localSocket
        : path.join("/tmp", `arisa-daemon-${crypto.createHash("sha256").update(root).digest("hex").slice(0, 24)}.sock`),
    capabilityFile: path.join(root, "daemon.capability")
  };
}

export async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function ensureDaemonCapability(pathsOrIdentity) {
  const paths = pathsOrIdentity.capabilityFile ? pathsOrIdentity : daemonPaths(pathsOrIdentity);
  await mkdir(paths.root, { recursive: true });
  try {
    const existing = (await readFile(paths.capabilityFile, "utf8")).trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(32).toString("base64url");
  try {
    await writeFile(paths.capabilityFile, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = (await readFile(paths.capabilityFile, "utf8")).trim();
    if (!existing) throw new Error(`Invalid daemon capability file for ${paths.toolName}`);
    return existing;
  }
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(Math.min(100, timeoutMs));
  }
  return !isProcessAlive(pid);
}

export async function writeDaemonStatus(pathsOrIdentity, patch) {
  if (patch.state && !DAEMON_STATES.includes(patch.state)) {
    throw new Error(`Invalid daemon state: ${patch.state}`);
  }
  const paths = pathsOrIdentity.statusFile ? pathsOrIdentity : daemonPaths(pathsOrIdentity);
  const current = await readJson(paths.statusFile, {});
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await writeJson(paths.statusFile, next);
  return next;
}

function daemonDisposition({ state, alive, autoStart, restartRequested }) {
  if (state === "failed") return "requires-attention";
  if (state === "restarting" || restartRequested) return "automatic-retry";
  if (["degraded", "unhealthy"].includes(state)) return autoStart ? "automatic-recovery" : "requires-attention";
  if (state === "stopped") return autoStart ? "automatic-restart" : "leave-stopped";
  if (state === "ready" && !alive) return autoStart ? "automatic-restart" : "start-on-demand";
  if (state === "ready") return "available";
  if (state === "starting") return "starting";
  return autoStart ? "automatic-start" : "start-on-demand";
}

function redactDiagnosticText(value) {
  if (!value) return null;
  return String(value)
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/\b(token|secret|password|api[_-]?key)(\s*[=:]\s*)[^\s,;&]+/gi, "$1$2[redacted]")
    .replace(/([?&](?:token|secret|password|api[_-]?key)=)[^\s&#]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/[^\s:/]+:)[^\s@/]+@/gi, "$1[redacted]@");
}

function diagnosticError(lastError) {
  if (!lastError) return null;
  return {
    ...lastError,
    message: redactDiagnosticText(lastError.message)
  };
}

export async function readDaemonDiagnostic({ toolName, scope, autoStart = false }) {
  const paths = daemonPaths({ toolName, scope });
  const status = await readJson(paths.statusFile, {});
  const { pid } = await readJson(paths.pidFile, {});
  const state = status.state || "not-started";
  const alive = isProcessAlive(pid);
  const restartRequested = Boolean(status.restartRequested);
  const hasActiveError = ["degraded", "unhealthy", "restarting", "failed"].includes(state);
  return {
    state,
    alive,
    pid: alive ? pid : null,
    message: redactDiagnosticText(status.message),
    lastError: hasActiveError ? diagnosticError(status.lastError) : null,
    restart: {
      attempts: Number(status.restartAttempts || 0),
      requested: restartRequested,
      nextAt: status.nextRestartAt || null
    },
    disposition: daemonDisposition({ state, alive, autoStart: Boolean(autoStart), restartRequested }),
    updatedAt: status.updatedAt || null,
    logFile: paths.logFile
  };
}

function registrationRecord({ paths, entryPath, autoStart, startupContext, current = {}, startedAt = null }) {
  return {
    toolName: paths.toolName,
    entryPath,
    scope: paths.scope,
    instanceId: paths.instanceId,
    autoStart: Boolean(autoStart),
    startupContext,
    registeredAt: current.registeredAt || new Date().toISOString(),
    lastStartedAt: startedAt || current.lastStartedAt || null
  };
}

export async function registerManagedDaemon({
  toolName,
  entryPath,
  scope = { type: "global" },
  startupContext = {},
  autoStart = true
}) {
  const paths = daemonPaths({ toolName, scope });
  const current = await readJson(paths.metaFile, {});
  const record = registrationRecord({
    paths,
    entryPath,
    autoStart,
    startupContext,
    current
  });
  await writeJson(paths.metaFile, record);
  return record;
}

export async function readDaemonLaunchContext({ expectedToolName = "" } = {}) {
  const metaFile = process.env.ARISA_DAEMON_META_FILE;
  if (!metaFile) return null;
  const record = await readJson(metaFile, null);
  if (!record?.toolName || !record?.entryPath || !record?.scope) {
    throw new Error(`Invalid daemon launch context at ${metaFile}`);
  }
  if (expectedToolName && record.toolName !== expectedToolName) {
    throw new Error(`Daemon launch context is for ${record.toolName}, expected ${expectedToolName}`);
  }
  return record;
}

async function acquireStartLock(paths, policy) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < policy.startupTimeoutMs) {
    try {
      await mkdir(paths.root, { recursive: true });
      await writeFile(paths.startLockFile, `${JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString()
      })}\n`, { flag: "wx" });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = await readJson(paths.pidFile, {});
      if (isProcessAlive(current.pid)) return false;
      const lock = await readJson(paths.startLockFile, {});
      if (lock.createdAt && Date.now() - new Date(lock.createdAt).getTime() >= policy.startupTimeoutMs) {
        await rm(paths.startLockFile, { force: true });
        continue;
      }
      await sleep(policy.queuePollIntervalMs);
    }
  }
  throw new Error(`Timed out acquiring daemon start lock for ${paths.toolName} (${paths.instanceId})`);
}

export async function unregisterManagedDaemon(toolNameOrOptions, { scope } = {}) {
  const paths = daemonPaths(toolNameOrOptions, scope);
  const { pid } = await readJson(paths.pidFile, {});
  if (isProcessAlive(pid)) {
    throw new Error(`Refusing to unregister a live daemon: ${paths.toolName} (${paths.instanceId})`);
  }
  await Promise.all([
    rm(paths.metaFile, { force: true }),
    rm(paths.pidFile, { force: true }),
    rm(paths.statusFile, { force: true }),
    rm(paths.startLockFile, { force: true }),
    rm(paths.capabilityFile, { force: true }),
    process.platform === "win32" ? Promise.resolve() : rm(paths.socketFile, { force: true }),
    rm(paths.commandsDir, { recursive: true, force: true })
  ]);
  return { toolName: paths.toolName, scope: paths.scope, instanceId: paths.instanceId };
}

export async function stopManagedDaemon(toolNameOrOptions, {
  scope,
  signal = "SIGTERM",
  forceAfterMs,
  state = "stopped",
  message = "Daemon stopped"
} = {}) {
  const paths = daemonPaths(toolNameOrOptions, scope);
  const policy = forceAfterMs == null ? await loadDaemonPolicy() : null;
  const effectiveForceAfterMs = forceAfterMs ?? policy.stopTimeoutMs;
  const { pid } = await readJson(paths.pidFile, {});
  let stopped = false;
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, signal);
      stopped = true;
    } catch {}
    if (signal !== "SIGKILL" && effectiveForceAfterMs > 0 && !(await waitForExit(pid, effectiveForceAfterMs))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  await rm(paths.pidFile, { force: true });
  if (state) {
    await writeDaemonStatus(paths, {
      state,
      pid: null,
      heartbeatAt: null,
      restartRequested: false,
      nextRestartAt: null,
      message
    });
  }
  return { toolName: paths.toolName, scope: paths.scope, pid: pid || null, stopped };
}

export async function startManagedDaemon({
  toolName,
  entryPath,
  scope = { type: "global" },
  startupContext = {},
  beforeStart = null,
  autoStart = true
}) {
  const paths = daemonPaths({ toolName, scope });
  const policy = await loadDaemonPolicy();
  await mkdir(paths.commandsDir, { recursive: true });

  const acquired = await acquireStartLock(paths, policy);
  if (acquired === false) {
    const current = await readJson(paths.pidFile, {});
    await registerManagedDaemon({
      toolName,
      entryPath,
      scope: paths.scope,
      startupContext,
      autoStart
    });
    return current.pid;
  }
  try {
    const current = await readJson(paths.pidFile, {});
    if (isProcessAlive(current.pid)) {
      await registerManagedDaemon({
        toolName,
        entryPath,
        scope: paths.scope,
        startupContext,
        autoStart
      });
      return current.pid;
    }
    await rm(paths.pidFile, { force: true });
    await mkdir(paths.commandsDir, { recursive: true });
    const capabilityToken = await ensureDaemonCapability(paths);
    if (process.platform !== "win32") await chmod(paths.capabilityFile, 0o600);
    if (beforeStart) await beforeStart();

    const startedAt = new Date().toISOString();
    const meta = registrationRecord({
      paths,
      entryPath,
      autoStart,
      startupContext,
      current: await readJson(paths.metaFile, {}),
      startedAt
    });
    await writeJson(paths.metaFile, meta);
    await writeDaemonStatus(paths, {
      state: "starting",
      pid: null,
      heartbeatAt: null,
      lastHealthCheckAt: null,
      lastHealthSuccessAt: null,
      consecutiveHealthFailures: 0,
      message: "Daemon process is starting"
    });

    const out = openSync(paths.logFile, "a");
    let child;
    try {
      const invocation = daemonProcessInvocation(entryPath);
      child = spawn(invocation.command, invocation.args, {
        detached: false,
        stdio: ["ignore", out, out],
        env: {
          ...process.env,
          ARISA_DAEMON_META_FILE: paths.metaFile,
          ARISA_DAEMON_INSTANCE_ID: paths.instanceId,
          ARISA_DAEMON_CAPABILITY: capabilityToken
        }
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } finally {
      closeSync(out);
    }
    const pidRegistration = writeJson(paths.pidFile, { pid: child.pid, startedAt });
    child.once("exit", async (exitCode, signal) => {
      await pidRegistration.catch(() => {});
      const currentPid = (await readJson(paths.pidFile, {})).pid;
      const currentStatus = await readJson(paths.statusFile, {});
      if (currentPid !== child.pid || ["stopped", "failed"].includes(currentStatus.state)) return;
      const exitReason = signal ? `signal ${signal}` : `exit code ${exitCode}`;
      await writeDaemonStatus(paths, {
        state: "degraded",
        pid: null,
        heartbeatAt: null,
        lastError: {
          at: new Date().toISOString(),
          phase: "process-exit",
          message: `Daemon process exited with ${exitReason}`,
          code: signal || `EXIT_${exitCode}`
        },
        message: `Daemon process exited with ${exitReason}`
      }).catch(() => {});
    });
    child.unref();

    await pidRegistration;
    await writeDaemonStatus(paths, {
      state: "starting",
      pid: child.pid,
      message: "Daemon process started; waiting for health check"
    });
    return child.pid;
  } catch (error) {
    await writeDaemonStatus(paths, {
      state: "failed",
      pid: null,
      lastError: {
        at: new Date().toISOString(),
        phase: "start",
        message: error?.message || String(error),
        ...(error?.code ? { code: error.code } : {})
      },
      message: error?.message || String(error)
    }).catch(() => {});
    throw error;
  } finally {
    if (acquired) await rm(paths.startLockFile, { force: true });
  }
}

async function listGlobalDaemonRecords() {
  let entries = [];
  try {
    entries = await readdir(toolStateDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let paths;
    try {
      paths = daemonPaths(entry.name);
    } catch {
      continue;
    }
    const meta = await readJson(paths.metaFile, null);
    if (meta?.toolName && meta?.entryPath) records.push(meta);
  }
  return records;
}

async function listChatDaemonRecords() {
  let chatEntries = [];
  try {
    chatEntries = await readdir(chatsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const chatEntry of chatEntries) {
    if (!chatEntry.isDirectory()) continue;
    let scope;
    try {
      scope = normalizeDaemonScope({ type: "chat", chatId: chatEntry.name });
    } catch {
      continue;
    }
    const toolsRoot = path.join(chatsDir, chatEntry.name, "state", "tools");
    const toolEntries = await readdir(toolsRoot, { withFileTypes: true }).catch(() => []);
    for (const toolEntry of toolEntries) {
      if (!toolEntry.isDirectory()) continue;
      let paths;
      try {
        paths = daemonPaths({ toolName: toolEntry.name, scope });
      } catch {
        continue;
      }
      const meta = await readJson(paths.metaFile, null);
      if (meta?.toolName && meta?.entryPath) records.push(meta);
    }
  }
  return records;
}

export async function listRegisteredDaemons() {
  const records = [
    ...await listGlobalDaemonRecords(),
    ...await listChatDaemonRecords()
  ];
  return records.sort((a, b) => `${a.toolName}:${a.instanceId}`.localeCompare(`${b.toolName}:${b.instanceId}`));
}
