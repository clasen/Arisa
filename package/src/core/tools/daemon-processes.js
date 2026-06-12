import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getToolStateDir, toolStateDir } from "../../runtime/paths.js";

export function daemonPaths(toolName) {
  const root = getToolStateDir(toolName);
  return {
    root,
    commandsDir: path.join(root, "commands"),
    pidFile: path.join(root, "daemon.pid"),
    metaFile: path.join(root, "daemon.meta.json"),
    statusFile: path.join(root, "status.json"),
    logFile: path.join(root, "daemon.log")
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
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

async function waitForExit(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

export async function stopManagedDaemon(toolName, { signal = "SIGTERM", forceAfterMs = 3000 } = {}) {
  const paths = daemonPaths(toolName);
  const { pid } = await readJson(paths.pidFile, {});
  let stopped = false;
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, signal);
      stopped = true;
    } catch {}
    if (signal !== "SIGKILL" && forceAfterMs > 0 && !(await waitForExit(pid, forceAfterMs))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  await rm(paths.pidFile, { force: true });
  return { toolName, pid: pid || null, stopped };
}

export async function startManagedDaemon({ toolName, entryPath, beforeStart = null, autoStart = true }) {
  const paths = daemonPaths(toolName);
  await mkdir(paths.commandsDir, { recursive: true });

  const current = await readJson(paths.pidFile, {});
  if (isProcessAlive(current.pid)) {
    await writeJson(paths.metaFile, {
      toolName,
      entryPath,
      autoStart,
      lastStartedAt: current.startedAt || new Date().toISOString()
    });
    return current.pid;
  }
  await rm(paths.pidFile, { force: true });

  await rm(paths.commandsDir, { recursive: true, force: true });
  await mkdir(paths.commandsDir, { recursive: true });
  if (beforeStart) await beforeStart();

  const out = openSync(paths.logFile, "a");
  try {
    const child = spawn(process.execPath, [entryPath, "daemon"], {
      detached: false,
      stdio: ["ignore", out, out],
      env: process.env
    });
    child.unref();

    const startedAt = new Date().toISOString();
    const record = {
      pid: child.pid,
      startedAt
    };
    await writeJson(paths.pidFile, record);
    await writeJson(paths.metaFile, {
      toolName,
      entryPath,
      autoStart,
      lastStartedAt: startedAt
    });
    return child.pid;
  } finally {
    closeSync(out);
  }
}

export async function listRegisteredDaemons() {
  let entries = [];
  try {
    entries = await readdir(toolStateDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const paths = daemonPaths(entry.name);
    const meta = await readJson(paths.metaFile, null);
    if (meta?.toolName && meta?.entryPath) records.push(meta);
  }
  return records;
}
