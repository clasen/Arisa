/**
 * @module daemon/codex-login
 * @role Trigger Codex device auth flow from Daemon when auth errors are detected.
 * @responsibilities
 *   - Detect codex auth-required signals in Core responses
 *   - Run `codex login --device-auth` in background from daemon process
 *   - Avoid duplicate runs with in-progress lock + cooldown
 * @effects Spawns codex CLI process, writes to daemon logs/terminal
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";

const log = createLogger("daemon");

const AUTH_HINT_PATTERNS = [
  /codex login --device-auth/i,
  /codex is not authenticated on this server/i,
  /missing bearer authentication in header/i,
];

const RETRY_COOLDOWN_MS = 30_000;

let loginInProgress = false;
let lastLoginAttemptAt = 0;

function needsCodexLogin(text: string): boolean {
  return AUTH_HINT_PATTERNS.some((pattern) => pattern.test(text));
}

export function maybeStartCodexDeviceAuth(rawCoreText: string): void {
  if (!rawCoreText || !needsCodexLogin(rawCoreText)) return;

  if (loginInProgress) {
    log.info("Codex device auth already in progress; skipping duplicate trigger");
    return;
  }

  const now = Date.now();
  if (now - lastLoginAttemptAt < RETRY_COOLDOWN_MS) {
    log.info("Codex device auth trigger ignored (cooldown active)");
    return;
  }

  lastLoginAttemptAt = now;
  loginInProgress = true;
  void runCodexDeviceAuth().finally(() => {
    loginInProgress = false;
  });
}

async function runCodexDeviceAuth(): Promise<void> {
  log.warn("Codex auth error detected. Running: codex login --device-auth");

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["codex", "login", "--device-auth"], {
      cwd: config.projectDir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
    });
  } catch (error) {
    log.error(`Failed to start codex login: ${error}`);
    return;
  }

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    log.info("Codex device auth finished successfully");
  } else {
    log.error(`Codex device auth finished with exit code ${exitCode}`);
  }
}
