import crypto from "node:crypto";
import net from "node:net";
import { chmod, mkdir, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import {
  daemonPaths,
  ensureDaemonCapability,
  isProcessAlive,
  readJson,
  startManagedDaemon,
  stopManagedDaemon,
  writeDaemonStatus,
  writeJson
} from "./daemon-processes.js";
import { loadDaemonPolicy } from "./daemon-policy.js";

const CONTROL_FIELD = "__daemon";
export const DAEMON_PROTOCOL_VERSION = 1;
export const DAEMON_EVENT_TYPES = Object.freeze(["accepted", "progress", "chunk", "completed", "failed"]);
const TERMINAL_EVENT_TYPES = new Set(["completed", "failed"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(work, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          error.code = "DAEMON_OPERATION_TIMEOUT";
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function jobPaths(paths, id) {
  return {
    request: path.join(paths.commandsDir, `${id}.request.json`),
    processing: path.join(paths.commandsDir, `${id}.processing.json`),
    result: path.join(paths.commandsDir, `${id}.result.json`)
  };
}

function daemonFrame(jobId, type, sequence, payload = {}) {
  return { version: DAEMON_PROTOCOL_VERSION, jobId, type, sequence, payload };
}

function terminalResult(frame) {
  if (frame.type === "failed") {
    const error = new Error(frame.payload?.error || "Daemon job failed");
    if (frame.payload?.code) error.code = frame.payload.code;
    throw error;
  }
  return frame.payload?.output || {};
}

async function readCapability(paths) {
  const token = (await readFile(paths.capabilityFile, "utf8")).trim();
  if (!token) throw new Error(`Invalid daemon capability for ${paths.toolName}`);
  return token;
}

async function writeSocketFrame(socket, frame, { maxFrameBytes = 1_048_576, streamBufferBytes = 1_048_576 } = {}) {
  if (socket.destroyed || !socket.writable) return false;
  const encoded = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > maxFrameBytes) {
    throw new Error(`Daemon IPC frame exceeds ${maxFrameBytes} bytes`);
  }
  if (socket.writableLength >= streamBufferBytes) {
    await new Promise((resolve) => {
      const finish = () => {
        socket.off("drain", finish);
        socket.off("close", finish);
        socket.off("error", finish);
        resolve();
      };
      socket.once("drain", finish);
      socket.once("close", finish);
      socket.once("error", finish);
    });
    if (socket.destroyed || !socket.writable) return false;
  }
  if (socket.write(encoded)) return true;
  await new Promise((resolve) => {
    const finish = () => {
      socket.off("drain", finish);
      socket.off("close", finish);
      socket.off("error", finish);
      resolve();
    };
    socket.once("drain", finish);
    socket.once("close", finish);
    socket.once("error", finish);
  });
  return !socket.destroyed;
}

function validateDaemonEvent(frame, { jobId, previousSequence = 0, terminalSeen = false } = {}) {
  if (!frame || frame.version !== DAEMON_PROTOCOL_VERSION || frame.jobId !== jobId) {
    throw new Error("Invalid daemon event identity or protocol version");
  }
  if (!DAEMON_EVENT_TYPES.includes(frame.type)) throw new Error(`Invalid daemon event type: ${frame.type}`);
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= previousSequence) {
    throw new Error(`Invalid daemon event sequence for ${jobId}: ${frame.sequence}`);
  }
  if (terminalSeen) throw new Error(`Daemon job ${jobId} emitted more than one terminal event`);
  return { sequence: frame.sequence, terminal: TERMINAL_EVENT_TYPES.has(frame.type) };
}

async function connectDaemon(paths, request, { timeoutMs, onEvent, maxFrameBytes }) {
  const startedAt = Date.now();
  const token = await readCapability(paths);
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(paths.socketFile);
        let buffer = "";
        let sequence = 0;
        let terminalSeen = false;
        let settled = false;
        let submitted = false;
        let timeoutTriggered = false;
        let observerChain = Promise.resolve();
        const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
        let cancelTimer;
        const timeoutError = Object.assign(
          new Error(`${paths.toolName} daemon job timed out after ${timeoutMs}ms`),
          { code: "DAEMON_JOB_TIMEOUT" }
        );
        const timer = setTimeout(() => {
          timeoutTriggered = true;
          if (submitted && !socket.destroyed && socket.writable) {
            const frame = `${JSON.stringify({
              version: DAEMON_PROTOCOL_VERSION,
              type: "cancel",
              jobId: request.jobId,
              capabilityToken: token
            })}\n`;
            socket.end(frame, () => finish(reject, timeoutError));
            cancelTimer = setTimeout(() => finish(reject, timeoutError), 50);
            cancelTimer.unref?.();
            return;
          }
          finish(reject, timeoutError);
        }, remainingMs);
        timer.unref?.();

        function finish(fn, value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(cancelTimer);
          socket.destroy();
          fn(value);
        }

        socket.setEncoding("utf8");
        socket.once("connect", () => {
          if (timeoutTriggered) return;
          submitted = true;
          socket.write(`${JSON.stringify({
            version: DAEMON_PROTOCOL_VERSION,
            type: "submit",
            jobId: request.jobId,
            capabilityToken: token
          })}\n`);
        });
        socket.on("data", (chunk) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer, "utf8") > maxFrameBytes && !buffer.includes("\n")) {
            finish(reject, new Error(`Daemon IPC frame exceeds ${maxFrameBytes} bytes`));
            return;
          }
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf("\n");
            if (!line) continue;
            let frame;
            try {
              frame = JSON.parse(line);
              const validated = validateDaemonEvent(frame, {
                jobId: request.jobId,
                previousSequence: sequence,
                terminalSeen
              });
              sequence = validated.sequence;
              terminalSeen = validated.terminal;
            } catch (error) {
              finish(reject, error);
              return;
            }
            observerChain = observerChain.then(() => onEvent?.(frame));
            if (terminalSeen) {
              observerChain.then(() => {
                if (timeoutTriggered) {
                  finish(reject, timeoutError);
                  return;
                }
                try {
                  finish(resolve, terminalResult(frame));
                } catch (error) {
                  finish(reject, error);
                }
              }, (error) => finish(reject, timeoutTriggered ? timeoutError : error));
            }
          }
        });
        socket.once("error", (error) => finish(reject, error));
        socket.once("close", () => {
          if (!settled) finish(reject, timeoutTriggered
            ? timeoutError
            : new Error("Daemon IPC connection closed before terminal result"));
        });
      });
    } catch (error) {
      lastError = error;
      if (!["ENOENT", "ECONNREFUSED"].includes(error?.code)) throw error;
      await sleep(Math.min(25, Math.max(1, timeoutMs - (Date.now() - startedAt))));
    }
  }
  const error = new Error(`${paths.toolName} daemon IPC was unavailable after ${timeoutMs}ms`);
  error.code = lastError?.code || "DAEMON_IPC_UNAVAILABLE";
  throw error;
}

async function enqueue(paths, payload, { control = false, timeoutMs, onEvent, jobId, maxFrameBytes } = {}) {
  await mkdir(paths.commandsDir, { recursive: true });
  const id = jobId || `${control ? "control" : "job"}-${crypto.randomUUID()}`;
  const files = jobPaths(paths, id);
  const existingResult = await readJson(files.result, null);
  if (existingResult?.terminal) {
    await onEvent?.(existingResult.terminal);
    return terminalResult(existingResult.terminal);
  }
  const existingRequest = await readJson(files.request, null);
  const existingAccepted = await readJson(files.processing, null);
  if (!existingRequest && !existingAccepted) {
    await writeJson(files.request, {
      id,
      status: "queued",
      queuedAt: new Date().toISOString(),
      payload
    });
  }
  return connectDaemon(paths, { jobId: id }, { timeoutMs, onEvent, maxFrameBytes });
}

export async function submitDaemonControl(record, operation, { timeoutMs, onEvent } = {}) {
  const paths = daemonPaths({ toolName: record.toolName, scope: record.scope });
  const policy = await loadDaemonPolicy();
  return enqueue(paths, { [CONTROL_FIELD]: { operation } }, {
    control: true,
    timeoutMs: timeoutMs ?? policy.healthTimeoutMs,
    onEvent,
    maxFrameBytes: policy.ipcFrameBytes || 1_048_576
  });
}

export function isDaemonReady(status, pid, policy, now = Date.now()) {
  if (status.state !== "ready" || !isProcessAlive(pid)) return false;
  const heartbeatAt = new Date(status.heartbeatAt || 0).getTime();
  const healthAt = new Date(status.lastHealthSuccessAt || 0).getTime();
  if (!heartbeatAt || now - heartbeatAt > policy.heartbeatStaleMs) return false;
  if (!healthAt || now - healthAt > policy.healthIntervalMs + policy.healthTimeoutMs) return false;
  return true;
}

export function createDaemonRuntime({
  toolName,
  entryPath,
  scope = { type: "global" },
  startupContext = {},
  beforeStart = null,
  autoStart = true
}) {
  const paths = daemonPaths({ toolName, scope });
  const registration = { toolName, entryPath, scope: paths.scope, startupContext, autoStart };
  let statusWrite = Promise.resolve();

  async function ensure() {
    await mkdir(paths.commandsDir, { recursive: true });
  }

  async function getPid() {
    return (await readJson(paths.pidFile, {})).pid;
  }

  async function writeStatus(patch) {
    statusWrite = statusWrite.catch(() => {}).then(() => writeDaemonStatus(paths, patch));
    return statusWrite;
  }

  async function start() {
    return startManagedDaemon({ ...registration, beforeStart });
  }

  async function stop() {
    await stopManagedDaemon({ toolName, scope: paths.scope });
  }

  async function waitReady({ timeoutMs } = {}) {
    const policy = await loadDaemonPolicy();
    const effectiveTimeoutMs = timeoutMs ?? policy.startupTimeoutMs;
    const startTime = Date.now();
    while (Date.now() - startTime < effectiveTimeoutMs) {
      const status = await readJson(paths.statusFile, {});
      const pid = await getPid();
      if (isDaemonReady(status, pid, policy)) return status;
      if (status.state === "failed") throw new Error(status.message || `${toolName} daemon failed`);
      await sleep(policy.queuePollIntervalMs);
    }
    throw new Error(`${toolName} daemon was not ready after ${effectiveTimeoutMs}ms`);
  }

  async function ensureReady({ timeoutMs } = {}) {
    const policy = await loadDaemonPolicy();
    const status = await readJson(paths.statusFile, {});
    const pid = await getPid();
    if (isDaemonReady(status, pid, policy)) return status;
    await submitDaemonControl(registration, "health", { timeoutMs: timeoutMs ?? policy.healthTimeoutMs });
    return waitReady({ timeoutMs: timeoutMs ?? policy.startupTimeoutMs });
  }

  async function submit(payload, {
    timeoutMs,
    readyTimeoutMs,
    requireReady = true,
    onEvent,
    jobId
  } = {}) {
    const policy = await loadDaemonPolicy();
    await start();
    if (requireReady) await ensureReady({ timeoutMs: readyTimeoutMs });
    return enqueue(paths, payload, {
      timeoutMs: timeoutMs ?? policy.startupTimeoutMs,
      onEvent,
      jobId,
      maxFrameBytes: policy.ipcFrameBytes || 1_048_576
    });
  }

  async function claimNext() {
    await ensure();
    const files = await readdir(paths.commandsDir);
    const pending = files
      .filter((file) => file.endsWith(".request.json") || file.endsWith(".processing.json"))
      .sort((a, b) => {
        const aControl = a.startsWith("control-") ? 0 : 1;
        const bControl = b.startsWith("control-") ? 0 : 1;
        return aControl - bControl || a.localeCompare(b);
      });
    for (const file of pending) {
      const id = file.replace(/\.(?:request|processing)\.json$/, "");
      const item = jobPaths(paths, id);
      if (await readJson(item.result, null)) {
        await Promise.all([unlink(item.request).catch(() => {}), unlink(item.processing).catch(() => {})]);
        continue;
      }
      try {
        if (file.endsWith(".request.json")) await rename(item.request, item.processing);
        const record = await readJson(item.processing, null);
        if (!record) continue;
        const accepted = {
          ...record,
          status: "accepted",
          acceptedAt: record.acceptedAt || new Date().toISOString()
        };
        await writeJson(item.processing, accepted);
        return { id, ...item, payload: accepted.payload };
      } catch {}
    }
    return null;
  }

  async function workLoop({
    processJob,
    healthCheck,
    recover = null,
    beforeExit = null,
    idleTimeoutMs = 0
  }) {
    if (typeof healthCheck !== "function") throw new Error(`${toolName} daemon must declare healthCheck`);
    const policy = await loadDaemonPolicy();
    const ipcLimits = {
      maxFrameBytes: policy.ipcFrameBytes || 1_048_576,
      streamBufferBytes: policy.streamBufferBytes || 1_048_576
    };
    const subscribers = new Map();
    const activeJobs = new Map();
    const cancelledJobs = new Set();
    let lastActivity = Date.now();
    let processing = false;
    let exiting = false;
    let acceptingWork = true;
    let processRequested = false;

    await ensure();
    const capabilityToken = process.env.ARISA_DAEMON_CAPABILITY || await ensureDaemonCapability(paths);
    await writeStatus({
      state: "starting",
      pid: process.pid,
      heartbeatAt: new Date().toISOString(),
      supportsRecovery: typeof recover === "function",
      message: "Daemon work loop started; waiting for health check"
    });

    async function publish(frame) {
      const sockets = [...(subscribers.get(frame.jobId) || [])];
      for (const socket of sockets) {
        if (!(await writeSocketFrame(socket, frame, ipcLimits))) subscribers.get(frame.jobId)?.delete(socket);
      }
    }

    async function persistTerminal(job, frame) {
      await writeJson(job.result, {
        id: job.id,
        status: frame.type,
        completedAt: new Date().toISOString(),
        terminal: frame
      });
      await unlink(job.processing).catch(() => {});
      await publish(frame);
    }

    async function execute(job) {
      let sequence = 1;
      const controller = new AbortController();
      activeJobs.set(job.id, controller);
      if (cancelledJobs.delete(job.id)) controller.abort();
      await publish(daemonFrame(job.id, "accepted", sequence, {}));
      const emit = async (type, payload = {}) => {
        if (!['progress', 'chunk'].includes(type)) throw new Error(`Invalid non-terminal daemon event type: ${type}`);
        sequence += 1;
        await publish(daemonFrame(job.id, type, sequence, payload));
      };
      const operation = job.payload?.[CONTROL_FIELD]?.operation;
      try {
        let output;
        if (operation === "health") {
          const checkedAt = new Date().toISOString();
          await writeStatus({ lastHealthCheckAt: checkedAt });
          output = await withTimeout(
            healthCheck,
            policy.healthTimeoutMs,
            `${toolName} health check timed out after ${policy.healthTimeoutMs}ms`
          );
          await writeStatus({
            state: "ready",
            lastHealthSuccessAt: new Date().toISOString(),
            consecutiveHealthFailures: 0,
            restartAttempts: 0,
            restartRequested: false,
            nextRestartAt: null,
            message: output?.message || "Daemon health check passed"
          });
          output ||= { ok: true };
        } else if (operation === "recover") {
          const recovered = typeof recover === "function"
            ? await withTimeout(recover, policy.healthTimeoutMs, `${toolName} recovery timed out after ${policy.healthTimeoutMs}ms`)
            : false;
          output = { recovered: recovered !== false };
        } else {
          lastActivity = Date.now();
          if (controller.signal.aborted) {
            throw Object.assign(new Error(`Daemon job cancelled: ${job.id}`), { code: "DAEMON_JOB_CANCELLED" });
          }
          output = await processJob(job.payload, { emit, jobId: job.id, signal: controller.signal });
          await writeStatus({ lastSuccessfulJobAt: new Date().toISOString() });
          lastActivity = Date.now();
        }
        sequence += 1;
        await persistTerminal(job, daemonFrame(job.id, "completed", sequence, { output }));
      } catch (error) {
        if (error?.code === "DAEMON_OPERATION_TIMEOUT") acceptingWork = false;
        const current = await readJson(paths.statusFile, {});
        await writeStatus({
          ...(operation === "health" ? {
            state: error?.code === "DAEMON_OPERATION_TIMEOUT" ? "unhealthy" : "degraded",
            consecutiveHealthFailures: Number(current.consecutiveHealthFailures || 0) + 1
          } : {}),
          lastError: {
            at: new Date().toISOString(),
            phase: operation || "job",
            message: error?.message || String(error),
            ...(error?.code ? { code: error.code } : {})
          },
          message: error?.message || String(error)
        });
        sequence += 1;
        await persistTerminal(job, daemonFrame(job.id, "failed", sequence, {
          error: error?.message || String(error),
          code: error?.code || null
        }));
      } finally {
        activeJobs.delete(job.id);
        cancelledJobs.delete(job.id);
      }
    }

    async function processQueue() {
      if (processing || exiting || !acceptingWork) {
        processRequested = true;
        return;
      }
      processing = true;
      try {
        do {
          processRequested = false;
          const job = await claimNext();
          if (!job) break;
          await execute(job);
        } while (!exiting && acceptingWork);
      } catch (error) {
        await writeStatus({
          state: "degraded",
          lastError: { at: new Date().toISOString(), phase: "work-loop", message: error?.message || String(error), ...(error?.code ? { code: error.code } : {}) },
          message: error?.message || String(error)
        });
      } finally {
        processing = false;
        if (processRequested && !exiting && acceptingWork) queueMicrotask(() => processQueue().catch(() => {}));
      }
    }

    if (process.platform !== "win32") await rm(paths.socketFile, { force: true });
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      const subscribedJobs = new Set();
      const removeSocket = () => {
        for (const jobId of subscribedJobs) subscribers.get(jobId)?.delete(socket);
      };
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > ipcLimits.maxFrameBytes && !buffer.includes("\n")) {
          socket.destroy();
          return;
        }
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf("\n");
          if (!line) continue;
          let notification;
          try {
            notification = JSON.parse(line);
          } catch {
            socket.destroy();
            return;
          }
          if (notification.version !== DAEMON_PROTOCOL_VERSION
            || !["submit", "cancel"].includes(notification.type)
            || typeof notification.jobId !== "string"
            || notification.capabilityToken !== capabilityToken) {
            socket.destroy();
            return;
          }
          const { jobId } = notification;
          if (notification.type === "cancel") {
            cancelledJobs.add(jobId);
            activeJobs.get(jobId)?.abort();
            continue;
          }
          if (!subscribers.has(jobId)) subscribers.set(jobId, new Set());
          subscribers.get(jobId).add(socket);
          subscribedJobs.add(jobId);
          readJson(jobPaths(paths, jobId).result, null).then((result) => {
            if (result?.terminal) return writeSocketFrame(socket, result.terminal, ipcLimits);
            return processQueue();
          }).catch(() => socket.destroy());
        }
      });
      socket.once("close", removeSocket);
      socket.once("error", removeSocket);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socketFile, resolve);
    });
    if (process.platform !== "win32") await chmod(paths.socketFile, 0o600);

    const heartbeatTimer = setInterval(() => {
      writeStatus({ heartbeatAt: new Date().toISOString() }).catch(() => {});
    }, policy.heartbeatIntervalMs);
    const idleTimer = idleTimeoutMs > 0 ? setInterval(async () => {
      if (processing || exiting || Date.now() - lastActivity <= idleTimeoutMs) return;
      exiting = true;
      clearInterval(heartbeatTimer);
      clearInterval(idleTimer);
      await beforeExit?.();
      await writeStatus({ state: "stopped", restartRequested: false, nextRestartAt: null, message: "Idle timeout reached" });
      server.close(() => process.exit(0));
    }, Math.min(idleTimeoutMs, 1_000)) : null;

    processQueue().catch(() => {});
  }

  return {
    paths,
    registration,
    ensure,
    getPid,
    writeStatus,
    start,
    stop,
    waitReady,
    ensureReady,
    submit,
    workLoop
  };
}
