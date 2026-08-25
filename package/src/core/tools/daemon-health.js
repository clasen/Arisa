import {
  daemonPaths,
  isProcessAlive,
  readJson,
  startManagedDaemon,
  stopManagedDaemon,
  writeDaemonStatus
} from "./daemon-processes.js";
import { retryDelay } from "./daemon-policy.js";
import { submitDaemonControl } from "./daemon-runtime.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorRecord(phase, error) {
  return {
    at: new Date().toISOString(),
    phase,
    message: error?.message || String(error),
    ...(error?.code ? { code: error.code } : {})
  };
}

function isTimeout(error) {
  return ["DAEMON_JOB_TIMEOUT", "DAEMON_OPERATION_TIMEOUT"].includes(error?.code);
}

function recordedError(status, fallback) {
  if (!status.lastError?.message) return fallback;
  const error = new Error(status.lastError.message);
  if (status.lastError.code) error.code = status.lastError.code;
  return error;
}

function healthDue(status, policy, now = Date.now()) {
  const heartbeatAt = new Date(status.heartbeatAt || 0).getTime();
  const healthAt = new Date(status.lastHealthCheckAt || 0).getTime();
  return status.state !== "ready"
    || !heartbeatAt
    || now - heartbeatAt > policy.heartbeatStaleMs
    || !healthAt
    || now - healthAt >= policy.healthIntervalMs;
}

async function probeWithRetries(record, paths, policy) {
  let lastError;
  for (let attempt = 0; attempt <= policy.healthRetryLimit; attempt += 1) {
    if (attempt > 0) {
      await sleep(policy.healthRetryBackoffMs * (2 ** (attempt - 1)));
    }
    try {
      return await submitDaemonControl(record, "health", {
        timeoutMs: policy.healthTimeoutMs
      });
    } catch (error) {
      lastError = error;
      const status = await readJson(paths.statusFile, {});
      await writeDaemonStatus(paths, {
        state: isTimeout(error) ? "unhealthy" : "degraded",
        ...(error?.code === "DAEMON_JOB_TIMEOUT"
          ? { consecutiveHealthFailures: Number(status.consecutiveHealthFailures || 0) + 1 }
          : {}),
        lastError: errorRecord("health", error),
        message: error?.message || String(error)
      });
      if (isTimeout(error)) throw error;
    }
  }
  throw lastError;
}

async function tryInternalRecovery(record, paths, policy) {
  const status = await readJson(paths.statusFile, {});
  if (!status.supportsRecovery) return false;
  await writeDaemonStatus(paths, {
    state: "restarting",
    message: "Attempting tool-specific recovery"
  });
  try {
    const result = await submitDaemonControl(record, "recover", {
      timeoutMs: policy.healthTimeoutMs
    });
    if (result.recovered === false) return false;
    await probeWithRetries(record, paths, policy);
    return true;
  } catch (error) {
    await writeDaemonStatus(paths, {
      state: "unhealthy",
      lastError: errorRecord("recovery", error),
      message: error?.message || String(error)
    });
    return false;
  }
}

async function scheduleRestart(record, paths, status, policy, reason) {
  const current = await readJson(paths.statusFile, status);
  const restartAttempts = Number(current.restartAttempts || 0) + 1;
  if (restartAttempts > policy.restartLimit && !record.autoStart) {
    await stopManagedDaemon(
      { toolName: record.toolName, scope: record.scope },
      { state: null }
    );
    await writeDaemonStatus(paths, {
      state: "failed",
      pid: null,
      heartbeatAt: null,
      restartAttempts,
      restartRequested: false,
      nextRestartAt: null,
      lastError: errorRecord("restart", reason),
      message: `Daemon restart limit reached: ${reason?.message || reason}`
    });
    return "failed";
  }

  const retainedAttempts = record.autoStart && restartAttempts > policy.restartLimit
    ? policy.restartLimit
    : restartAttempts;
  const delayMs = retryDelay(restartAttempts, policy);
  await stopManagedDaemon(
    { toolName: record.toolName, scope: record.scope },
    { state: null }
  );
  await writeDaemonStatus(paths, {
    state: "restarting",
    pid: null,
    heartbeatAt: null,
    restartAttempts: retainedAttempts,
    restartRequested: true,
    nextRestartAt: new Date(Date.now() + delayMs).toISOString(),
    lastError: errorRecord("restart", reason),
    message: `Daemon will restart after ${delayMs}ms`
  });
  return "restart-scheduled";
}

async function restartIfDue(record, paths, status, policy) {
  if (!record.autoStart && !status.restartRequested) return "stopped";
  if (status.state === "failed") return "failed";
  const nextRestartAt = new Date(status.nextRestartAt || 0).getTime();
  if (nextRestartAt && Date.now() < nextRestartAt) return "backoff";
  if (Number(status.restartAttempts || 0) > policy.restartLimit) {
    await writeDaemonStatus(paths, {
      state: "failed",
      restartRequested: false,
      nextRestartAt: null,
      message: "Daemon restart limit reached"
    });
    return "failed";
  }
  await startManagedDaemon({
    toolName: record.toolName,
    entryPath: record.entryPath,
    scope: record.scope,
    startupContext: record.startupContext,
    autoStart: record.autoStart
  });
  return "started";
}

export async function superviseDaemon(record, policy) {
  const paths = daemonPaths({ toolName: record.toolName, scope: record.scope });
  const { pid } = await readJson(paths.pidFile, {});
  const status = await readJson(paths.statusFile, {});
  const alive = isProcessAlive(pid);

  if (!alive) {
    if (status.state === "failed") return "failed";
    if (!record.autoStart && !status.restartRequested && ["stopped", "unhealthy", "failed"].includes(status.state)) {
      return status.state;
    }
    if (!status.state || status.state === "stopped") {
      return restartIfDue(record, paths, status, policy);
    }
    if (status.state === "restarting") {
      return restartIfDue(record, paths, status, policy);
    }
    return scheduleRestart(record, paths, status, policy, recordedError(status, new Error("Daemon process exited")));
  }

  if (!healthDue(status, policy)) return "healthy";

  try {
    await probeWithRetries(record, paths, policy);
    return "healthy";
  } catch (error) {
    if (!isTimeout(error) && await tryInternalRecovery(record, paths, policy)) return "recovered";
    await writeDaemonStatus(paths, {
      state: "unhealthy",
      lastError: errorRecord("health", error),
      message: error?.message || String(error)
    });
    return scheduleRestart(record, paths, status, policy, error);
  }
}
