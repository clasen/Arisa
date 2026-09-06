import net from "node:net";
import { chmod, readdir, rename, rm, unlink } from "node:fs/promises";
import {
  ensureDaemonCapability,
  readJson,
  writeDaemonStatus,
  writeJson
} from "./daemon-processes.js";
import { loadDaemonPolicy } from "./daemon-policy.js";
import { ensureDaemonJournal, maintainDaemonJournal } from "./daemon-journal.js";
import {
  DAEMON_CONTROL_FIELD,
  DAEMON_PROTOCOL_VERSION,
  daemonFrame,
  daemonJobPaths,
  writeDaemonSocketFrame
} from "./daemon-protocol.js";

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

export function createDaemonWorker({ toolName, paths }) {
  let statusWrite = Promise.resolve();

  async function ensure() {
    await ensureDaemonJournal(paths);
  }

  async function getPid() {
    return (await readJson(paths.pidFile, {})).pid;
  }

  async function writeStatus(patch) {
    statusWrite = statusWrite.catch(() => {}).then(() => writeDaemonStatus(paths, patch));
    return statusWrite;
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
      const item = daemonJobPaths(paths, id);
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
    const deliveredSequences = new WeakMap();
    const activeJobs = new Map();
    const cancelledJobs = new Set();
    let lastActivity = Date.now();
    let processing = false;
    let exiting = false;
    let acceptingWork = true;
    let processRequested = false;
    let journalMaintenance = Promise.resolve();

    function maintainJournal() {
      const operation = journalMaintenance
        .catch(() => {})
        .then(() => maintainDaemonJournal(paths, policy));
      journalMaintenance = operation;
      return operation;
    }

    const journal = await maintainJournal();
    const capabilityToken = process.env.ARISA_DAEMON_CAPABILITY || await ensureDaemonCapability(paths);
    await writeStatus({
      state: "starting",
      pid: process.pid,
      heartbeatAt: new Date().toISOString(),
      supportsRecovery: typeof recover === "function",
      journal,
      message: "Daemon work loop started; waiting for health check"
    });

    async function sendFrame(socket, frame) {
      const delivered = deliveredSequences.get(socket) || new Map();
      if ((delivered.get(frame.jobId) || 0) >= frame.sequence) return true;
      const sent = await writeDaemonSocketFrame(socket, frame, ipcLimits);
      if (sent) {
        delivered.set(frame.jobId, frame.sequence);
        deliveredSequences.set(socket, delivered);
      }
      return sent;
    }

    async function publish(frame) {
      const sockets = [...(subscribers.get(frame.jobId) || [])];
      for (const socket of sockets) {
        if (!(await sendFrame(socket, frame))) subscribers.get(frame.jobId)?.delete(socket);
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
        if (!["progress", "chunk"].includes(type)) throw new Error(`Invalid non-terminal daemon event type: ${type}`);
        sequence += 1;
        await publish(daemonFrame(job.id, type, sequence, payload));
      };
      const operation = job.payload?.[DAEMON_CONTROL_FIELD]?.operation;
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
          readJson(daemonJobPaths(paths, jobId).result, null).then((result) => {
            if (result?.terminal) return sendFrame(socket, result.terminal);
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
    const journalTimer = setInterval(() => {
      maintainJournal()
        .then((journal) => writeStatus({ journal }))
        .catch((error) => writeStatus({
          lastError: { at: new Date().toISOString(), phase: "journal", message: error?.message || String(error) }
        }));
    }, policy.journalSweepIntervalMs || 5 * 60_000);
    journalTimer.unref?.();
    const idleTimer = idleTimeoutMs > 0 ? setInterval(async () => {
      if (processing || exiting || Date.now() - lastActivity <= idleTimeoutMs) return;
      exiting = true;
      clearInterval(heartbeatTimer);
      clearInterval(journalTimer);
      clearInterval(idleTimer);
      await beforeExit?.();
      await writeStatus({ state: "stopped", restartRequested: false, nextRestartAt: null, message: "Idle timeout reached" });
      server.close(() => process.exit(0));
    }, Math.min(idleTimeoutMs, 1_000)) : null;

    processQueue().catch(() => {});
  }

  return { ensure, getPid, writeStatus, claimNext, workLoop };
}
