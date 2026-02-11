/**
 * @module daemon/lifecycle
 * @role Spawn and manage the Core process with --watch for hot reload.
 * @responsibilities
 *   - Start Core as a child process with `bun --watch`
 *   - Restart Core if it crashes
 *   - Capture stderr for error diagnostics
 *   - Expose Core status (up/down, last error)
 * @dependencies shared/config
 * @effects Spawns child process, manages process lifecycle
 * @contract startCore() => void, getCoreError() => string | null, isCoreUp() => boolean
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import { join } from "path";

const log = createLogger("daemon");

let coreProcess: ReturnType<typeof Bun.spawn> | null = null;
let shouldRun = true;
let lastError: string | null = null;
let crashCount = 0;
let lastCrashAt = 0;

const STDERR_MAX = 2000;

export function getCoreError(): string | null {
  return lastError;
}

export function isCoreUp(): boolean {
  return coreProcess !== null;
}

export function startCore() {
  if (!shouldRun) return;

  const coreEntry = join(config.projectDir, "src", "core", "index.ts");
  log.info(`Starting Core: bun --watch ${coreEntry}`);

  coreProcess = Bun.spawn(["bun", "--watch", coreEntry], {
    cwd: config.projectDir,
    stdout: "inherit",
    stderr: "pipe",
    env: { ...process.env },
    onExit(proc, exitCode, signalCode) {
      log.warn(`Core exited (code=${exitCode}, signal=${signalCode})`);
      coreProcess = null;

      const now = Date.now();
      if (now - lastCrashAt < 10_000) {
        crashCount++;
      } else {
        crashCount = 1;
      }
      lastCrashAt = now;

      if (crashCount > 5) {
        log.error(`Core crash loop detected (${crashCount} crashes in rapid succession)`);
      }

      if (shouldRun) {
        log.info("Restarting Core in 2s...");
        setTimeout(() => startCore(), 2000);
      }
    },
  });

  // Capture stderr in a rolling buffer
  if (coreProcess.stderr) {
    const reader = coreProcess.stderr.getReader();
    const decoder = new TextDecoder();
    let stderrBuf = "";

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // Also print to daemon's stderr so logs aren't lost
          process.stderr.write(chunk);
          stderrBuf += chunk;
          if (stderrBuf.length > STDERR_MAX) {
            stderrBuf = stderrBuf.slice(-STDERR_MAX);
          }
        }
      } catch {
        // stream closed
      }
      // When stream ends (Core exited), save the buffer as lastError
      if (stderrBuf.trim()) {
        lastError = stderrBuf.trim();
      }
    })();
  }

  log.info(`Core spawned (pid=${coreProcess.pid})`);
}

export function stopCore() {
  shouldRun = false;
  if (coreProcess) {
    log.info("Stopping Core...");
    coreProcess.kill();
    coreProcess = null;
  }
}
