import path from "node:path";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const maxOutputBytes = 50 * 1024;
const defaultTimeoutMs = 60_000;

function isPowerShell(shellPath) {
  const name = path.basename(shellPath).toLowerCase();
  return name === "powershell.exe" || name === "powershell" || name === "pwsh.exe" || name === "pwsh";
}

function isCmd(shellPath) {
  const name = path.basename(shellPath).toLowerCase();
  return name === "cmd.exe" || name === "cmd";
}

function resolveNativeShell(shellPath = "") {
  if (shellPath) {
    if (isPowerShell(shellPath)) {
      return {
        shell: shellPath,
        label: "powershell",
        argsFor: (command) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]
      };
    }
    if (isCmd(shellPath)) {
      return {
        shell: shellPath,
        label: "cmd",
        argsFor: (command) => ["/d", "/s", "/c", command]
      };
    }
    return {
      shell: shellPath,
      label: "sh",
      argsFor: (command) => ["-lc", command]
    };
  }

  if (process.platform === "win32") {
    return {
      shell: "powershell.exe",
      label: "powershell",
      argsFor: (command) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]
    };
  }

  return {
    shell: existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh",
    label: "sh",
    argsFor: (command) => ["-lc", command]
  };
}

function appendLimited(current, chunk, state) {
  state.totalBytes += chunk.length;

  const remaining = maxOutputBytes - state.storedBytes;
  if (remaining <= 0) {
    state.truncated = true;
    return current;
  }

  const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  state.storedBytes += accepted.length;
  if (accepted.length < chunk.length) {
    state.truncated = true;
  }
  return current + accepted.toString("utf8");
}

function killProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Process already exited.
    }
  }
}

function formatOutput({ stdout, stderr, exitCode, timedOut, truncated }) {
  const sections = [];
  if (stdout.trim()) sections.push(`stdout:\n${stdout.trimEnd()}`);
  if (stderr.trim()) sections.push(`stderr:\n${stderr.trimEnd()}`);
  if (!sections.length) sections.push(exitCode === 0 && !timedOut ? "(Success, no output)" : "(No output)");
  if (timedOut) sections.push("Command timed out.");
  if (truncated) sections.push(`[Output truncated to ${maxOutputBytes} bytes.]`);
  return sections.join("\n\n");
}

async function runShellCommand({ command, cwd, shellPath, timeoutMs }) {
  await access(cwd, constants.F_OK);
  const nativeShell = resolveNativeShell(shellPath);
  const child = spawn(nativeShell.shell, nativeShell.argsFor(command), {
    cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  const outputState = {
    storedBytes: 0,
    totalBytes: 0,
    truncated: false
  };

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, timeoutMs);

  return new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk, outputState);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk, outputState);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error,
        stdout,
        stderr,
        shell: nativeShell,
        timedOut,
        truncated: outputState.truncated,
        totalBytes: outputState.totalBytes
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode,
        stdout,
        stderr,
        shell: nativeShell,
        timedOut,
        truncated: outputState.truncated,
        totalBytes: outputState.totalBytes
      });
    });
  });
}

function isArisaRestartCommand(command) {
  return /^\s*arisa\s+restart\s*$/i.test(String(command || ""));
}

export function createSystemShellTool({ workspaceDir, shell = {}, beforeRestart, cancelRestart }) {
  return defineTool({
    name: "system_shell",
    label: "System Shell",
    description: "Run a command in the active Arisa workspace using the native system shell: PowerShell on Windows, and sh/bash-compatible shell on Unix.",
    parameters: Type.Object({
      command: Type.String({ description: "Command to execute in the active workspace." }),
      timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds for this command." })),
      restartSummary: Type.Optional(Type.String({ maxLength: 500, description: "Concrete user-facing result to report after an arisa restart succeeds." }))
    }),
    execute: async (_id, params) => {
      const timeoutMs = Number.isFinite(Number(params.timeoutMs)) && Number(params.timeoutMs) > 0
        ? Math.floor(Number(params.timeoutMs))
        : (shell.timeoutMs || defaultTimeoutMs);
      const restartReceipt = isArisaRestartCommand(params.command) && typeof beforeRestart === "function"
        ? await beforeRestart(params.restartSummary)
        : null;
      const result = await runShellCommand({
        command: params.command,
        cwd: workspaceDir,
        shellPath: shell.shellPath,
        timeoutMs
      });
      if (!result.ok && restartReceipt?.id && typeof cancelRestart === "function") {
        await cancelRestart(restartReceipt.id).catch(() => {});
      }
      const details = {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? null,
        shell: result.shell.label,
        shellPath: result.shell.shell,
        cwd: workspaceDir,
        timedOut: result.timedOut,
        truncated: result.truncated,
        totalBytes: result.totalBytes
      };
      if (result.error) {
        details.error = result.error.message;
      }
      return {
        content: [{ type: "text", text: result.error?.message || formatOutput(result) }],
        details,
        isError: !result.ok
      };
    }
  });
}
