import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:fs";

export function defaultBinaryPath(toolStateDir) {
  return path.join(toolStateDir, "bin", "lightpanda");
}

export async function resolveBinary(configuredPath, toolStateDir) {
  const binary = String(configuredPath || "").trim() || defaultBinaryPath(toolStateDir);
  if (!path.isAbsolute(binary)) throw new Error("LIGHTPANDA_BINARY must be an absolute path.");
  await access(binary, constants.X_OK);
  return binary;
}

export function runProcess(command, args, { timeoutMs = 10_000, maxCaptureBytes = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH || "" } });
    const stdout = [];
    const stderr = [];
    let captured = 0;
    let timedOut = false;
    const capture = (target) => (chunk) => {
      if (captured >= maxCaptureBytes) return;
      const available = maxCaptureBytes - captured;
      const bounded = chunk.subarray(0, available);
      target.push(bounded);
      captured += bounded.length;
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

export async function readBinaryVersion(binary) {
  const result = await runProcess(binary, ["version"], { timeoutMs: 10_000, maxCaptureBytes: 16 * 1024 });
  if (result.timedOut) throw new Error("Lightpanda version check timed out.");
  if (result.code !== 0) throw new Error(`Lightpanda version check failed: ${result.stderr || result.stdout}`.trim());
  return (result.stdout || result.stderr).trim();
}
