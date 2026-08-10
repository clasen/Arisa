import { open, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ensureArisaHome, serviceLogFile, servicePidFile } from "./paths.js";

export const serviceEntryFile = fileURLToPath(new URL("../index.js", import.meta.url));

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requirePositiveTiming(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Service restart requires a positive ${name}`);
  }
}

async function readPid() {
  try {
    const raw = await readFile(servicePidFile, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function getServiceStatus() {
  await ensureArisaHome();
  const pid = await readPid();
  if (!pid) return { running: false, pid: null };
  if (!isProcessRunning(pid)) {
    await rm(servicePidFile, { force: true }).catch(() => {});
    return { running: false, pid: null, stalePid: pid };
  }
  return { running: true, pid };
}

export async function startService({ verbose = true, cliArgs = [] } = {}) {
  await ensureArisaHome();
  const status = await getServiceStatus();
  if (status.running) {
    return { ok: false, reason: "already-running", pid: status.pid };
  }

  const logHandle = await open(serviceLogFile, "a");
  const args = [serviceEntryFile, "--service-runner", ...cliArgs];
  if (!verbose) args.push("--silent");

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
    env: process.env
  });

  child.unref();
  await logHandle.close();
  return { ok: true, pid: child.pid, logFile: serviceLogFile };
}

export async function stopService() {
  const status = await getServiceStatus();
  if (!status.running) {
    return { ok: false, reason: "not-running", pid: status.stalePid || null };
  }

  try {
    process.kill(status.pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") {
      await rm(servicePidFile, { force: true }).catch(() => {});
      return { ok: false, reason: "not-running", pid: status.pid };
    }
    throw error;
  }

  return { ok: true, pid: status.pid };
}

export async function waitForServiceStop({
  pid,
  timeoutMs,
  pollIntervalMs,
  getStatus = getServiceStatus,
  wait = sleep
}) {
  requirePositiveTiming(timeoutMs, "shutdownTimeoutMs");
  requirePositiveTiming(pollIntervalMs, "shutdownPollIntervalMs");

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await getStatus();
    if (!status.running || status.pid !== pid) return;
    await wait(pollIntervalMs);
  }

  throw new Error(`Arisa process ${pid} did not stop within ${timeoutMs}ms`);
}

export async function restartService({
  verbose = true,
  cliArgs = [],
  shutdownTimeoutMs,
  shutdownPollIntervalMs
} = {}, {
  stop = stopService,
  getStatus = getServiceStatus,
  start = startService,
  sleep: wait = sleep
} = {}) {
  requirePositiveTiming(shutdownTimeoutMs, "shutdownTimeoutMs");
  requirePositiveTiming(shutdownPollIntervalMs, "shutdownPollIntervalMs");

  const stopped = await stop();
  if (!stopped.ok && stopped.reason !== "not-running") return stopped;

  if (stopped.ok) {
    await waitForServiceStop({
      pid: stopped.pid,
      timeoutMs: shutdownTimeoutMs,
      pollIntervalMs: shutdownPollIntervalMs,
      getStatus,
      wait
    });
  }

  const started = await start({ verbose, cliArgs });
  return {
    ...started,
    previousPid: stopped.ok ? stopped.pid : null,
    wasRunning: stopped.ok
  };
}

export async function unregisterServiceProcess() {
  await rm(servicePidFile, { force: true }).catch(() => {});
}

export async function registerServiceProcess() {
  await ensureArisaHome();
  await writeFile(servicePidFile, `${process.pid}\n`, "utf8");

  process.on("exit", () => {
    rm(servicePidFile, { force: true }).catch(() => {});
  });
}
