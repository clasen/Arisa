import {
  daemonPaths,
  isProcessAlive,
  readJson,
  startManagedDaemon,
  stopManagedDaemon
} from "./daemon-processes.js";
import { loadDaemonPolicy } from "./daemon-policy.js";
import { enqueueDaemonJob, submitDaemonControl } from "./daemon-client.js";
import { createDaemonWorker } from "./daemon-worker.js";

export { submitDaemonControl } from "./daemon-client.js";
export { DAEMON_EVENT_TYPES, DAEMON_PROTOCOL_VERSION } from "./daemon-protocol.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const worker = createDaemonWorker({ toolName, paths });

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
      const pid = await worker.getPid();
      if (isDaemonReady(status, pid, policy)) return status;
      if (status.state === "failed") throw new Error(status.message || `${toolName} daemon failed`);
      await sleep(policy.queuePollIntervalMs);
    }
    throw new Error(`${toolName} daemon was not ready after ${effectiveTimeoutMs}ms`);
  }

  async function ensureReady({ timeoutMs } = {}) {
    const policy = await loadDaemonPolicy();
    const status = await readJson(paths.statusFile, {});
    const pid = await worker.getPid();
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
    return enqueueDaemonJob(paths, payload, {
      timeoutMs: timeoutMs ?? policy.startupTimeoutMs,
      onEvent,
      jobId,
      maxFrameBytes: policy.ipcFrameBytes || 1_048_576
    });
  }

  return {
    paths,
    registration,
    ensure: worker.ensure,
    getPid: worker.getPid,
    writeStatus: worker.writeStatus,
    start,
    stop,
    waitReady,
    ensureReady,
    submit,
    workLoop: worker.workLoop
  };
}
