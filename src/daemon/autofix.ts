/**
 * @module daemon/autofix
 * @role Auto-diagnose and fix Core crashes using Claude CLI.
 * @responsibilities
 *   - Spawn Claude CLI to analyze crash errors and edit code
 *   - Rate-limit attempts (cooldown + max attempts)
 *   - Notify via callback (Telegram)
 * @dependencies shared/config
 * @effects Spawns claude CLI process which may edit project files
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";

const log = createLogger("daemon");

let lastAttemptAt = 0;
let attemptCount = 0;

const COOLDOWN_MS = 120_000; // 2min between batches
const MAX_ATTEMPTS = 3;
const AUTOFIX_TIMEOUT = 180_000; // 3min for autofix

type NotifyFn = (text: string) => Promise<void>;
let notifyFn: NotifyFn | null = null;

export function setAutoFixNotify(fn: NotifyFn) {
  notifyFn = fn;
}

/**
 * Attempt to auto-fix a Core crash. Returns true if Claude was invoked successfully.
 */
export async function attemptAutoFix(error: string): Promise<boolean> {
  const now = Date.now();

  // Reset attempts after cooldown
  if (now - lastAttemptAt > COOLDOWN_MS) {
    attemptCount = 0;
  }

  if (attemptCount >= MAX_ATTEMPTS) {
    log.warn(`Auto-fix: max attempts (${MAX_ATTEMPTS}) reached, waiting for cooldown`);
    return false;
  }

  attemptCount++;
  lastAttemptAt = now;

  log.info(`Auto-fix: attempt ${attemptCount}/${MAX_ATTEMPTS}`);
  await notifyFn?.(`Auto-fix: intento ${attemptCount}/${MAX_ATTEMPTS}. Analizando error...`);

  // Extract file paths from the error to help Claude focus
  const fileRefs = error.match(/\/srv\/tinyclaw\/[^\s:)]+/g) || [];
  const uniqueFiles = [...new Set(fileRefs)].slice(0, 5);
  const fileHint = uniqueFiles.length > 0
    ? `\nKey files from the stack trace: ${uniqueFiles.join(", ")}`
    : "";

  const prompt = `TinyClaw Core error on startup. Fix it.

Error:
\`\`\`
${error.slice(-1500)}
\`\`\`
${fileHint}

Rules:
- If it's a corrupted JSON/data file: delete or recreate it
- If it's a bad import: fix the import
- If it's a code bug: fix the minimal code
- Do NOT refactor, improve, or change anything beyond the fix
- Be fast — read only the files mentioned in the error`;

  try {
    const proc = Bun.spawn(
      ["claude", "--dangerously-skip-permissions", "--model", "sonnet", "-p", prompt],
      {
        cwd: config.projectDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      }
    );

    const timeout = setTimeout(() => {
      proc.kill();
    }, AUTOFIX_TIMEOUT);

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    const hasOutput = output.trim().length > 0;

    if (exitCode !== 0 && !hasOutput) {
      // Claude failed without producing any output — real failure
      const stderr = await new Response(proc.stderr).text();
      log.error(`Auto-fix: Claude CLI failed (exit=${exitCode}): ${stderr.slice(0, 500)}`);
      await notifyFn?.("Auto-fix: Claude CLI falló sin producir resultado. Revisá los logs.");
      return false;
    }

    // Claude produced output — it attempted a fix (even if exit code is non-zero,
    // it may have edited files before encountering a secondary issue)
    const summary = output.trim().slice(0, 300);
    if (exitCode !== 0) {
      log.warn(`Auto-fix: Claude exited with code ${exitCode} but produced output — treating as attempted fix`);
    }
    log.info(`Auto-fix: Claude completed. Output: ${summary}`);
    await notifyFn?.(`Auto-fix aplicado. Core reiniciando...\n<pre>${escapeHtml(summary)}</pre>`);
    return true;
  } catch (err) {
    log.error(`Auto-fix: error: ${err}`);
    await notifyFn?.("Auto-fix: error interno. Revisá los logs.");
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
