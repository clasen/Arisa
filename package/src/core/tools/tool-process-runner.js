import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { arisaIpcSocketFile, arisaPackageDir } from "../../platform/paths.js";
import { daemonConfigDefaults } from "../config/config-defaults.js";
import { createToolOutputParser } from "./tool-process-output.js";

const execFileAsync = promisify(execFile);
const mebibyte = 1024 * 1024;

export function toolProcessEnv() {
  return { ...process.env, ARISA_PACKAGE_DIR: arisaPackageDir, ARISA_IPC_SOCKET: arisaIpcSocketFile };
}

export function isolatedToolProcessInvocation(nodeArgs, execution, {
  platform = process.platform,
  systemdAvailable = existsSync("/run/systemd/system"),
  oomAdjustAvailable = existsSync("/usr/bin/choom")
} = {}) {
  if (!execution?.maxMemoryMb || platform !== "linux" || !systemdAvailable) {
    return { command: process.execPath, args: nodeArgs, isolated: false };
  }
  const memoryHighPercent = Number.isSafeInteger(execution.memoryHighPercent)
    ? execution.memoryHighPercent
    : 85;
  const memoryHighMb = Math.max(1, Math.floor(execution.maxMemoryMb * memoryHighPercent / 100));
  const swapMaxMb = Number.isSafeInteger(execution.swapMaxMb) ? execution.swapMaxMb : 128;
  return {
    command: "systemd-run",
    args: [
      "--scope",
      "--quiet",
      "--collect",
      "--slice=arisa-tools.slice",
      "-p", `MemoryHigh=${memoryHighMb}M`,
      "-p", `MemoryMax=${execution.maxMemoryMb}M`,
      "-p", `MemorySwapMax=${swapMaxMb}M`,
      "--",
      ...(oomAdjustAvailable ? ["choom", "-n", "500", "--"] : []),
      process.execPath,
      ...nodeArgs
    ],
    isolated: true
  };
}

function terminateToolProcess(child, signal) {
  if (process.platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}

async function readProcessRssBytes(pid) {
  if (process.platform === "linux") {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) * 1024 : 0;
  }
  const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
  return Number(stdout.trim()) * 1024;
}

// Enforces maxRssMb on the tool process itself. Runtimes without a V8 heap flag
// (Bun) and hosts without cgroups otherwise have no per-tool memory limit.
function watchToolMemory(child, { maxRssMb, pollIntervalMs, label, onFailure }) {
  if (!maxRssMb || process.platform === "win32" || !Number.isInteger(child.pid)) return () => {};
  let sampling = false;
  const timer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      const rssBytes = await readProcessRssBytes(child.pid);
      if (rssBytes > maxRssMb * mebibyte) {
        clearInterval(timer);
        const error = new Error(`${label} exceeded its ${maxRssMb} MiB memory limit (RSS ${Math.ceil(rssBytes / mebibyte)} MiB)`);
        error.code = "TOOL_PROCESS_MEMORY_LIMIT";
        onFailure(error);
      }
    } catch (cause) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      clearInterval(timer);
      const error = new Error(`${label} memory watchdog could not read RSS: ${cause.message}`);
      error.code = "TOOL_PROCESS_MEMORY_WATCH";
      onFailure(error);
    } finally {
      sampling = false;
    }
  }, pollIntervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function waitForToolProcess(child, { timeoutMs, killGraceMs, label, maxRssMb, memoryPollIntervalMs }) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let memoryError = null;
    let forceTimer = null;
    const stop = () => {
      terminateToolProcess(child, "SIGTERM");
      forceTimer = setTimeout(() => terminateToolProcess(child, "SIGKILL"), killGraceMs);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const stopWatching = watchToolMemory(child, {
      maxRssMb,
      pollIntervalMs: memoryPollIntervalMs,
      label,
      onFailure: (error) => {
        memoryError = error;
        clearTimeout(timeout);
        stop();
      }
    });

    const finish = (callback, value) => {
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      stopWatching();
      callback(value);
    };

    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      if (memoryError) {
        finish(reject, memoryError);
        return;
      }
      if (!timedOut) {
        finish(resolve, code);
        return;
      }
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = "TOOL_PROCESS_TIMEOUT";
      finish(reject, error);
    });
  });
}

export async function runToolHelpProcess(command, args, {
  timeoutMs,
  killGraceMs,
  label,
  maxRssMb,
  memoryPollIntervalMs,
  maxOutputBytes = daemonConfigDefaults.ipcFrameBytes,
  ...options
} = {}) {
  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    ...options,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let outputBytes = 0;
  let outputError = null;
  let forceTimer = null;
  const append = (current, chunk, decoder) => {
    if (outputError) return current;
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) {
      outputError = new Error(`${label} output exceeds ${maxOutputBytes} bytes`);
      outputError.code = "TOOL_OUTPUT_LIMIT";
      terminateToolProcess(child, "SIGTERM");
      forceTimer = setTimeout(() => terminateToolProcess(child, "SIGKILL"), killGraceMs);
      forceTimer.unref?.();
      return current;
    }
    return current + decoder.write(chunk);
  };
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, stdoutDecoder); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, stderrDecoder); });
  const code = await waitForToolProcess(child, { timeoutMs, killGraceMs, label, maxRssMb, memoryPollIntervalMs });
  clearTimeout(forceTimer);
  if (outputError) throw outputError;
  return { code, stdout: stdout + stdoutDecoder.end(), stderr: stderr + stderrDecoder.end() };
}

export async function runToolProcess(command, args, {
  onEvent,
  maxFrameBytes,
  maxOutputBytes,
  parserName,
  timeoutMs,
  killGraceMs,
  label,
  maxRssMb,
  memoryPollIntervalMs,
  ...options
} = {}) {
  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    ...options,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const parser = createToolOutputParser(parserName || path.basename(args[0] || command), { onEvent, maxFrameBytes, maxOutputBytes });
  const stderrChunks = [];
  let stderrBytes = 0;
  let stdoutError = null;
  let outputForceTimer = null;
  const stdoutTask = (async () => {
    try {
      for await (const chunk of child.stdout) await parser.push(chunk);
      return parser.finish();
    } catch (error) {
      stdoutError = error;
      terminateToolProcess(child, "SIGTERM");
      outputForceTimer = setTimeout(() => terminateToolProcess(child, "SIGKILL"), killGraceMs);
      outputForceTimer.unref?.();
      return null;
    }
  })();
  const stderrTask = (async () => {
    for await (const chunk of child.stderr) {
      if (stderrBytes >= maxFrameBytes) continue;
      const accepted = chunk.subarray(0, maxFrameBytes - stderrBytes);
      stderrChunks.push(accepted);
      stderrBytes += accepted.length;
    }
    return Buffer.concat(stderrChunks).toString("utf8");
  })();
  child.stdout.resume();
  child.stderr.resume();
  let code;
  try {
    code = await waitForToolProcess(child, { timeoutMs, killGraceMs, label, maxRssMb, memoryPollIntervalMs });
  } catch (error) {
    await Promise.allSettled([stdoutTask, stderrTask]);
    throw error;
  }
  const [parsed, stderr] = await Promise.all([stdoutTask, stderrTask]);
  clearTimeout(outputForceTimer);
  if (stdoutError) throw stdoutError;
  return { code, parsed, stderr };
}
