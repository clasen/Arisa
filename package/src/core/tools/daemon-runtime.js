import crypto from "node:crypto";
import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  daemonPaths,
  isProcessAlive,
  readJson,
  startManagedDaemon,
  stopManagedDaemon,
  writeDaemonStatus,
  writeJson
} from "./daemon-processes.js";
import { loadDaemonPolicy } from "./daemon-policy.js";

const CONTROL_FIELD = "__daemon";

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

async function waitForResult(paths, id, { timeoutMs, intervalMs }) {
  const files = jobPaths(paths, id);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await readJson(files.result, null);
    if (result) {
      await unlink(files.result).catch(() => {});
      if (!result.ok) {
        const error = new Error(result.error || `${paths.toolName} daemon job failed`);
        if (result.code) error.code = result.code;
        throw error;
      }
      return result.output || {};
    }
    await sleep(intervalMs);
  }
  const error = new Error(`${paths.toolName} daemon job timed out after ${timeoutMs}ms`);
  error.code = "DAEMON_JOB_TIMEOUT";
  throw error;
}

async function enqueue(paths, payload, { control = false, timeoutMs, intervalMs }) {
  await mkdir(paths.commandsDir, { recursive: true });
  const id = `${control ? "control" : "job"}-${crypto.randomUUID()}`;
  await writeJson(jobPaths(paths, id).request, { id, ...payload });
  return waitForResult(paths, id, { timeoutMs, intervalMs });
}

export async function submitDaemonControl(record, operation, { timeoutMs } = {}) {
  const paths = daemonPaths({ toolName: record.toolName, scope: record.scope });
  const policy = await loadDaemonPolicy();
  return enqueue(paths, {
    [CONTROL_FIELD]: { operation }
  }, {
    control: true,
    timeoutMs: timeoutMs ?? policy.healthTimeoutMs,
    intervalMs: policy.queuePollIntervalMs
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
    return startManagedDaemon({
      ...registration,
      beforeStart
    });
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
    await submitDaemonControl(registration, "health", {
      timeoutMs: timeoutMs ?? policy.healthTimeoutMs
    });
    return waitReady({ timeoutMs: timeoutMs ?? policy.startupTimeoutMs });
  }

  async function submit(payload, {
    timeoutMs,
    readyTimeoutMs,
    requireReady = true
  } = {}) {
    const policy = await loadDaemonPolicy();
    await start();
    if (requireReady) await ensureReady({ timeoutMs: readyTimeoutMs });
    return enqueue(paths, payload, {
      timeoutMs: timeoutMs ?? policy.startupTimeoutMs,
      intervalMs: policy.queuePollIntervalMs
    });
  }

  async function claimNext() {
    await ensure();
    const files = (await readdir(paths.commandsDir))
      .filter((file) => file.endsWith(".request.json"))
      .sort((a, b) => {
        const aControl = a.startsWith("control-") ? 0 : 1;
        const bControl = b.startsWith("control-") ? 0 : 1;
        return aControl - bControl || a.localeCompare(b);
      });
    for (const file of files) {
      const id = file.replace(/\.request\.json$/, "");
      const item = jobPaths(paths, id);
      try {
        await rename(item.request, item.processing);
        return { id, ...item, payload: await readJson(item.processing, null) };
      } catch {}
    }
    return null;
  }

  async function complete(job, output) {
    await writeJson(job.result, { ok: true, output });
    await unlink(job.processing).catch(() => {});
  }

  async function fail(job, error) {
    await writeJson(job.result, {
      ok: false,
      error: error?.message || String(error),
      code: error?.code || null
    });
    await unlink(job.processing).catch(() => {});
  }

  async function workLoop({
    processJob,
    healthCheck,
    recover = null,
    beforeExit = null,
    idleTimeoutMs = 0
  }) {
    if (typeof healthCheck !== "function") {
      throw new Error(`${toolName} daemon must declare healthCheck`);
    }
    const policy = await loadDaemonPolicy();
    const intervalMs = policy.queuePollIntervalMs;
    let lastActivity = Date.now();
    let processing = false;
    let exiting = false;
    let acceptingWork = true;

    await ensure();
    await writeStatus({
      state: "starting",
      pid: process.pid,
      heartbeatAt: new Date().toISOString(),
      supportsRecovery: typeof recover === "function",
      message: "Daemon work loop started; waiting for health check"
    });

    const heartbeatTimer = setInterval(() => {
      writeStatus({ heartbeatAt: new Date().toISOString() }).catch(() => {});
    }, policy.heartbeatIntervalMs);

    const workTimer = setInterval(async () => {
      if (processing || exiting || !acceptingWork) return;
      processing = true;
      try {
        const job = await claimNext();
        if (job) {
          const operation = job.payload?.[CONTROL_FIELD]?.operation;
          try {
            if (operation === "health") {
              const checkedAt = new Date().toISOString();
              await writeStatus({ lastHealthCheckAt: checkedAt });
              const output = await withTimeout(
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
              await complete(job, output || { ok: true });
            } else if (operation === "recover") {
              const recovered = typeof recover === "function"
                ? await withTimeout(
                    recover,
                    policy.healthTimeoutMs,
                    `${toolName} recovery timed out after ${policy.healthTimeoutMs}ms`
                  )
                : false;
              await complete(job, { recovered: recovered !== false });
            } else {
              lastActivity = Date.now();
              const output = await processJob(job.payload);
              await writeStatus({ lastSuccessfulJobAt: new Date().toISOString() });
              await complete(job, output);
              lastActivity = Date.now();
            }
          } catch (error) {
            if (error?.code === "DAEMON_OPERATION_TIMEOUT") {
              acceptingWork = false;
            }
            const current = await readJson(paths.statusFile, {});
            await writeStatus({
              ...(operation === "health"
                ? {
                    state: error?.code === "DAEMON_OPERATION_TIMEOUT" ? "unhealthy" : "degraded",
                    consecutiveHealthFailures: Number(current.consecutiveHealthFailures || 0) + 1
                  }
                : {}),
              lastError: {
                at: new Date().toISOString(),
                phase: operation || "job",
                message: error?.message || String(error)
              },
              message: error?.message || String(error)
            });
            await fail(job, error);
          }
        }
        if (idleTimeoutMs > 0 && Date.now() - lastActivity > idleTimeoutMs) {
          exiting = true;
          clearInterval(heartbeatTimer);
          clearInterval(workTimer);
          if (beforeExit) await beforeExit();
          await writeStatus({
            state: "stopped",
            restartRequested: false,
            nextRestartAt: null,
            message: "Idle timeout reached"
          });
          process.exit(0);
        }
      } catch (error) {
        await writeStatus({
          state: "degraded",
          lastError: {
            at: new Date().toISOString(),
            phase: "work-loop",
            message: error?.message || String(error)
          },
          message: error?.message || String(error)
        });
      } finally {
        processing = false;
      }
    }, intervalMs);

    submitDaemonControl(registration, "health", {
      timeoutMs: policy.healthTimeoutMs
    }).catch(() => {});
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
