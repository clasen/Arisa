import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parsePosixProcesses(output) {
  return String(output || "")
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }));
}

function parseWindowsProcesses(output) {
  const parsed = JSON.parse(output || "[]");
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records
    .filter((record) => record?.ProcessId && record?.CommandLine)
    .map((record) => ({ pid: Number(record.ProcessId), command: String(record.CommandLine) }));
}

export async function listSystemProcesses({ timeoutMs, platform = process.platform } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Process inspection requires a positive timeoutMs");
  }
  if (platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    ], { timeout: timeoutMs, windowsHide: true });
    return parseWindowsProcesses(stdout);
  }
  const { stdout } = await execFileAsync("ps", ["-ww", "-axo", "pid=,command="], { timeout: timeoutMs });
  return parsePosixProcesses(stdout);
}

export function isArisaServiceProcess(record, entryFile) {
  return record.command.includes(entryFile)
    && /(?:^|\s)--service-runner(?:\s|$)/.test(record.command);
}

export function isDaemonProcess(record, daemon) {
  return record.command.includes(daemon.entryPath)
    && /(?:^|\s)daemon(?:\s|$)/.test(record.command);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function terminateProcess(pid, { forceAfterMs } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error(`Refusing to terminate invalid process target: ${pid}`);
  }
  if (!Number.isFinite(forceAfterMs) || forceAfterMs <= 0) {
    throw new Error("Process cleanup requires a positive forceAfterMs");
  }
  if (!isAlive(pid)) return false;
  process.kill(pid, "SIGTERM");
  const startedAt = Date.now();
  while (Date.now() - startedAt < forceAfterMs) {
    if (!isAlive(pid)) return true;
    await sleep(Math.min(100, forceAfterMs));
  }
  if (isAlive(pid)) process.kill(pid, "SIGKILL");
  return true;
}
