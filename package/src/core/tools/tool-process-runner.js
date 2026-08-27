import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { arisaIpcSocketFile, arisaPackageDir } from "../../platform/paths.js";
import { daemonConfigDefaults } from "../config/config-defaults.js";
import { createToolOutputParser } from "./tool-process-output.js";

export function toolProcessEnv() {
  return { ...process.env, ARISA_PACKAGE_DIR: arisaPackageDir, ARISA_IPC_SOCKET: arisaIpcSocketFile };
}

export function isolatedToolProcessInvocation(nodeArgs, execution, {
  platform = process.platform,
  systemdAvailable = existsSync("/run/systemd/system"),
  oomAdjustAvailable = existsSync("/usr/bin/choom")
} = {}) {
  if (!execution?.maxMemoryMb || platform !== "linux" || !systemdAvailable) {
    return { command: "node", args: nodeArgs, isolated: false };
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
      "node",
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

function waitForToolProcess(child, { timeoutMs, killGraceMs, label }) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let forceTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateToolProcess(child, "SIGTERM");
      forceTimer = setTimeout(() => terminateToolProcess(child, "SIGKILL"), killGraceMs);
    }, timeoutMs);

    const finish = (callback, value) => {
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      callback(value);
    };

    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
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
  let outputBytes = 0;
  let outputError = null;
  let forceTimer = null;
  const append = (current, chunk) => {
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
    return current + chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  const code = await waitForToolProcess(child, { timeoutMs, killGraceMs, label });
  clearTimeout(forceTimer);
  if (outputError) throw outputError;
  return { code, stdout, stderr };
}

export async function runToolProcess(command, args, {
  onEvent,
  maxFrameBytes,
  maxOutputBytes,
  parserName,
  timeoutMs,
  killGraceMs,
  label,
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
    code = await waitForToolProcess(child, { timeoutMs, killGraceMs, label });
  } catch (error) {
    await Promise.allSettled([stdoutTask, stderrTask]);
    throw error;
  }
  const [parsed, stderr] = await Promise.all([stdoutTask, stderrTask]);
  clearTimeout(outputForceTimer);
  if (stdoutError) throw stdoutError;
  return { code, parsed, stderr };
}
