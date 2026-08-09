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
  } catch {
    return false;
  }
}

async function readPid() {
  try {
    const raw = await readFile(servicePidFile, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
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
  } catch {
    await rm(servicePidFile, { force: true }).catch(() => {});
    return { ok: false, reason: "not-running", pid: status.pid };
  }

  return { ok: true, pid: status.pid };
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
