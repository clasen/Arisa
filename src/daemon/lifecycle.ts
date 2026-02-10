/**
 * @module daemon/lifecycle
 * @role Spawn and manage the Core process with --watch for hot reload.
 * @responsibilities
 *   - Start Core as a child process with `bun --watch`
 *   - Restart Core if it crashes
 *   - Health check loop
 * @dependencies shared/config
 * @effects Spawns child process, manages process lifecycle
 * @contract startCore() => void
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import { join } from "path";

const log = createLogger("daemon");

let coreProcess: ReturnType<typeof Bun.spawn> | null = null;
let shouldRun = true;

export function startCore() {
  if (!shouldRun) return;

  const coreEntry = join(config.projectDir, "src", "core", "index.ts");
  log.info(`Starting Core: bun --watch ${coreEntry}`);

  coreProcess = Bun.spawn(["bun", "--watch", coreEntry], {
    cwd: config.projectDir,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
    onExit(proc, exitCode, signalCode) {
      log.warn(`Core exited (code=${exitCode}, signal=${signalCode})`);
      coreProcess = null;
      if (shouldRun) {
        log.info("Restarting Core in 2s...");
        setTimeout(() => startCore(), 2000);
      }
    },
  });

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
