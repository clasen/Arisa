import { spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  assertServiceIdentity,
  isProcessAlive,
  readPidFile,
  readUtf8Json,
  retireLock,
  runProcess,
  terminalPrompt,
  waitFor,
  writeUtf8Json
} from "./lib.js";

const toolName = "arisa-restart";
const thisWorkerFile = fileURLToPath(import.meta.url);
const notifierFile = path.join(path.dirname(thisWorkerFile), "notifier.js");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const now = () => new Date().toISOString();

async function assertLockOwner(job) {
  const lock = await readUtf8Json(job.lockFile);
  if (!lock || lock.jobId !== job.id || lock.token !== job.lockToken) {
    throw new Error("Restart worker no longer owns the active-job lock");
  }
}

async function updateStatus(job, patch) {
  const current = await readUtf8Json(job.statusFile, job);
  const next = { ...current, ...patch, updatedAt: now(), workerPid: process.pid };
  await writeUtf8Json(job.statusFile, next);
  const latest = await readUtf8Json(job.latestFile);
  if (!latest || latest.id === job.id) await writeUtf8Json(job.latestFile, next);
  return next;
}

export function requestIpc({ socketPath, method = "tools.list", chatId = null, params = {}, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const request = {
      id: `arisa-restart-${process.pid}-${Date.now()}`,
      method,
      toolName,
      chatId,
      capabilityToken: "",
      params
    };
    let buffer = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("Arisa IPC request timed out")), timeoutMs);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response.ok) throw new Error(response.error || "Arisa IPC request failed");
        finish(resolve, response.result);
      } catch (error) {
        finish(reject, error);
      }
    });
    socket.once("error", (error) => finish(reject, error));
    socket.once("close", () => finish(reject, new Error("Arisa IPC closed before replying")));
  });
}

async function probeService(job, expected = null) {
  const pid = await readPidFile(job.pidFile);
  if (!isProcessAlive(pid)) throw new Error("Arisa PID file does not point to a live service");
  if (expected?.pid && pid !== expected.pid) throw new Error(`Arisa PID changed during verification from ${expected.pid} to ${pid}`);
  const identity = await assertServiceIdentity(pid, job.entryFile, expected?.startTime || null);
  const tools = await requestIpc({ socketPath: job.ipcSocketFile, timeoutMs: 5000 });
  if (!Array.isArray(tools)) throw new Error("Arisa IPC health check returned an unexpected response");
  return identity;
}

async function currentLogSize(logFile) {
  try { return (await stat(logFile)).size; } catch { return 0; }
}

async function pollingStartedAfter(job, offset) {
  try {
    const size = await currentLogSize(job.serviceLogFile);
    if (size <= offset) return false;
    const length = Math.min(size - offset, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const handle = await open(job.serviceLogFile, "r");
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead).toString("utf8").includes("[telegram] bot polling started");
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function waitForStableService(job, logOffset) {
  const deadline = Date.now() + job.config.verifyTimeoutMs;
  let stableSince = null;
  let expected = null;
  let lastError = null;
  let telegramReady = false;
  while (Date.now() < deadline) {
    try {
      if (!expected) {
        const pid = await readPidFile(job.pidFile);
        const identity = await assertServiceIdentity(pid, job.entryFile);
        expected = { pid: identity.pid, startTime: identity.startTime };
      }
      const identity = await probeService(job, expected);
      telegramReady ||= await pollingStartedAfter(job, logOffset);
      if (!telegramReady) throw new Error("Telegram polling readiness was not observed for the replacement service");
      if (stableSince == null) stableSince = Date.now();
      if (Date.now() - stableSince >= job.config.stabilityWindowMs) return identity;
    } catch (error) {
      lastError = error;
      stableSince = null;
    }
    await sleep(500);
  }
  throw new Error(`Arisa did not remain healthy: ${lastError?.message || "stability window timed out"}`);
}

export async function terminateVerifiedService(job, identity, label = "Arisa") {
  await assertServiceIdentity(identity.pid, job.entryFile, identity.startTime);
  process.kill(identity.pid, "SIGTERM");
  const stoppedGracefully = await waitFor(() => !isProcessAlive(identity.pid), {
    timeoutMs: job.config.stopTimeoutMs,
    intervalMs: 250
  });
  if (stoppedGracefully) return { forced: false };

  await assertServiceIdentity(identity.pid, job.entryFile, identity.startTime);
  process.kill(identity.pid, "SIGKILL");
  const stoppedForcefully = await waitFor(() => !isProcessAlive(identity.pid), {
    timeoutMs: job.config.killTimeoutMs,
    intervalMs: 100
  });
  if (!stoppedForcefully) throw new Error(`${label} PID ${identity.pid} survived verified SIGKILL escalation`);
  return { forced: true };
}

async function stopService(job, expectedIdentity) {
  const pidFromFile = await readPidFile(job.pidFile);
  if (pidFromFile !== expectedIdentity.pid) {
    throw new Error(`Arisa PID changed from ${expectedIdentity.pid} to ${pidFromFile || "missing"}; refusing to signal it`);
  }
  return terminateVerifiedService(job, expectedIdentity);
}

async function startService(job) {
  const logOffset = await currentLogSize(job.serviceLogFile);
  const result = await runProcess(process.execPath, [job.entryFile, "start", ...(job.restartArgs || [])], {
    cwd: job.packageDir,
    env: { ...process.env, ARISA_IPC_TOKEN: "" },
    timeoutMs: job.config.startTimeoutMs
  });
  if (result.code !== 0 || result.error || result.timedOut) {
    try {
      await probeService(job);
      return logOffset;
    } catch {}
    const detail = [result.error, result.stderr.trim(), result.stdout.trim()].find(Boolean) || `exit ${result.code}`;
    throw new Error(`Arisa start command failed: ${detail}`);
  }
  return logOffset;
}

async function stopReplacement(job) {
  const pid = await readPidFile(job.pidFile);
  if (!isProcessAlive(pid)) return;
  const identity = await assertServiceIdentity(pid, job.entryFile);
  await terminateVerifiedService(job, identity, "Replacement Arisa");
  return identity;
}

async function recoverAfterStop(job) {
  if (isProcessAlive(job.oldPid)) {
    await assertServiceIdentity(job.oldPid, job.entryFile, job.oldStartTime);
    throw new Error("The signalled old Arisa process is still alive; refusing to start a duplicate service");
  }
  await stopReplacement(job);
  const logOffset = await startService(job);
  return waitForStableService(job, logOffset);
}

async function acquireNotificationClaim(job) {
  const claimFile = `${job.statusFile}.notify.lock`;
  try {
    await acquireLock(claimFile, { jobId: job.id, pid: process.pid, createdAt: now() });
    return claimFile;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const claim = await readUtf8Json(claimFile);
  if (claim?.pid && isProcessAlive(claim.pid)) return null;
  await retireLock(claimFile);
  try {
    await acquireLock(claimFile, { jobId: job.id, pid: process.pid, createdAt: now() });
    return claimFile;
  } catch (error) {
    if (error?.code === "EEXIST") return null;
    throw error;
  }
}

export async function queueNotification(job, status) {
  if (!job.config.notifyOnCompletion || !job.chatId || status.notificationQueued) return status;
  const claimFile = await acquireNotificationClaim(job);
  if (!claimFile) return readUtf8Json(job.statusFile, status);
  const prompt = terminalPrompt(job, status);
  try {
    await requestIpc({
      socketPath: job.ipcSocketFile,
      method: "agent.enqueueEvent",
      chatId: job.chatId,
      params: { prompt },
      timeoutMs: 10000
    });
    return updateStatus(job, {
      notificationQueued: true,
      notificationPending: false,
      notificationError: null
    });
  } catch (error) {
    await retireLock(claimFile);
    return updateStatus(job, {
      notificationQueued: false,
      notificationPending: true,
      notificationError: error.message
    });
  }
}

function launchNotifier(job) {
  const child = spawn(process.execPath, [notifierFile, job.statusFile], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ARISA_IPC_TOKEN: "" }
  });
  child.once("error", (error) => {
    console.error(`[arisa-restart] notifier launch failed: ${error.message}`);
  });
  child.unref();
}

async function finalizeNotification(job, status) {
  const notified = await queueNotification(job, status);
  if (notified.notificationPending) launchNotifier(job);
  return notified;
}

export async function executeJob(job) {
  let phase = "handoff";
  let oldWasSignalled = false;
  try {
    await assertLockOwner(job);
    await updateStatus(job, { state: "queued", phase: "handoff" });
    await sleep(job.config.handoffDelayMs);
    await assertLockOwner(job);

    phase = "preflight";
    await updateStatus(job, { state: "running", phase });
    if ((await readPidFile(job.pidFile)) !== job.oldPid) throw new Error("The active Arisa PID changed before handoff completed");
    const oldIdentity = await assertServiceIdentity(job.oldPid, job.entryFile, job.oldStartTime);

    phase = "stop";
    await updateStatus(job, { state: "stopping", phase });
    oldWasSignalled = true;
    const stopResult = await stopService(job, oldIdentity);

    phase = "start";
    await updateStatus(job, { state: "starting", phase, stopEscalated: stopResult.forced });
    const logOffset = await startService(job);

    phase = "verify";
    await updateStatus(job, { state: "verifying", phase });
    const identity = await waitForStableService(job, logOffset);
    let status = await updateStatus(job, {
      state: "succeeded",
      phase: "complete",
      newPid: identity.pid,
      newStartTime: identity.startTime,
      recovered: false,
      completedAt: now()
    });
    status = await finalizeNotification(job, status);
    return status;
  } catch (error) {
    console.error(`[arisa-restart] ${phase}: ${error.stack || error.message || String(error)}`);
    let status;
    if (oldWasSignalled) {
      await updateStatus(job, { state: "recovering", phase: "recovery", error: error.message, failurePhase: phase });
      try {
        const identity = await recoverAfterStop(job);
        status = await updateStatus(job, {
          state: "succeeded",
          phase: "complete",
          error: error.message,
          failurePhase: phase,
          newPid: identity.pid,
          newStartTime: identity.startTime,
          recovered: true,
          completedAt: now()
        });
      } catch (recoveryError) {
        status = await updateStatus(job, {
          state: "failed",
          phase,
          error: error.message,
          recoveryError: recoveryError.message,
          recovered: false,
          completedAt: now()
        });
      }
    } else {
      status = await updateStatus(job, {
        state: "failed",
        phase,
        error: error.message,
        recovered: isProcessAlive(job.oldPid),
        recoveryPid: isProcessAlive(job.oldPid) ? job.oldPid : null,
        completedAt: now()
      });
    }
    return finalizeNotification(job, status);
  }
}

async function main() {
  const statusFile = process.argv[2];
  if (!statusFile) throw new Error("Worker job file argument is required");
  const job = await readUtf8Json(statusFile);
  if (!job) throw new Error("Worker could not read its restart job");
  job.statusFile = statusFile;
  if (path.resolve(job.workerFile) !== path.resolve(thisWorkerFile)) throw new Error("Restart job references a different worker");
  await executeJob(job);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisWorkerFile)) {
  main().catch((error) => {
    console.error(`[arisa-restart] fatal: ${error.stack || error.message || String(error)}`);
    process.exitCode = 1;
  });
}
