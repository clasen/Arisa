import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getToolStateDir } from "../../runtime/paths.js";

export function daemonPaths(toolName) {
  const root = getToolStateDir(toolName);
  return {
    root,
    commandsDir: path.join(root, "commands"),
    pidFile: path.join(root, "daemon.pid"),
    statusFile: path.join(root, "status.json"),
    logFile: path.join(root, "daemon.log")
  };
}

export async function readJson(file, fallback = {}) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function createDaemonRuntime({ toolName, entryPath, beforeStart = null }) {
  const paths = daemonPaths(toolName);

  async function ensure() {
    await mkdir(paths.commandsDir, { recursive: true });
  }

  function jobPaths(id) {
    return {
      request: path.join(paths.commandsDir, `${id}.request.json`),
      processing: path.join(paths.commandsDir, `${id}.processing.json`),
      result: path.join(paths.commandsDir, `${id}.result.json`)
    };
  }

  async function getPid() {
    return (await readJson(paths.pidFile, {})).pid;
  }

  async function writeStatus(patch) {
    const current = await readJson(paths.statusFile, {});
    await writeJson(paths.statusFile, { ...current, ...patch, updatedAt: new Date().toISOString() });
  }

  async function clearJobs() {
    await rm(paths.commandsDir, { recursive: true, force: true });
    await mkdir(paths.commandsDir, { recursive: true });
  }

  async function start() {
    await ensure();
    const pid = await getPid();
    if (isProcessAlive(pid)) return pid;

    await clearJobs();
    if (beforeStart) await beforeStart();
    const out = openSync(paths.logFile, "a");
    const child = spawn(process.execPath, [entryPath, "daemon"], {
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env
    });
    child.unref();
    await writeJson(paths.pidFile, { pid: child.pid, startedAt: new Date().toISOString() });
    return child.pid;
  }

  async function stop() {
    const pid = await getPid();
    if (isProcessAlive(pid)) process.kill(pid, "SIGTERM");
    await rm(paths.pidFile, { force: true });
  }

  async function waitReady({ timeoutMs = 120000, readyStates = ["ready"] } = {}) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const status = await readJson(paths.statusFile, {});
      const pid = await getPid();
      if (readyStates.includes(status.state) && isProcessAlive(pid)) return status;
      if (status.state === "error") throw new Error(status.message || `${toolName} daemon failed`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`${toolName} daemon was not ready after ${timeoutMs}ms`);
  }

  async function submit(payload, { timeoutMs = 180000, readyTimeoutMs = 120000 } = {}) {
    await start();
    await waitReady({ timeoutMs: readyTimeoutMs });
    const id = crypto.randomUUID();
    const files = jobPaths(id);
    await writeJson(files.request, { id, ...payload });

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const result = await readJson(files.result, null);
      if (result) {
        await unlink(files.result).catch(() => {});
        if (!result.ok) throw new Error(result.error || `${toolName} job failed`);
        return result.output || {};
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`${toolName} job timed out after ${timeoutMs}ms`);
  }

  async function claimNext() {
    await ensure();
    const files = (await readdir(paths.commandsDir)).filter((file) => file.endsWith(".request.json"));
    for (const file of files) {
      const id = file.replace(/\.request\.json$/, "");
      const item = jobPaths(id);
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
    await writeJson(job.result, { ok: false, error: error?.message || String(error) });
    await unlink(job.processing).catch(() => {});
  }

  async function workLoop({ processJob, idleTimeoutMs = 0, intervalMs = 250 }) {
    let lastActivity = Date.now();
    setInterval(async () => {
      try {
        const job = await claimNext();
        if (job) {
          lastActivity = Date.now();
          try {
            await complete(job, await processJob(job.payload));
          } catch (error) {
            await fail(job, error);
          }
          lastActivity = Date.now();
        }
        if (idleTimeoutMs > 0 && Date.now() - lastActivity > idleTimeoutMs) {
          await writeStatus({ state: "stopped", message: "Idle timeout reached" });
          process.exit(0);
        }
      } catch (error) {
        await writeStatus({ state: "error", message: error?.message || String(error) });
      }
    }, intervalMs);
  }

  return { paths, ensure, getPid, writeStatus, start, stop, waitReady, submit, workLoop };
}
