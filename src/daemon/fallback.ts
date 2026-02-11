/**
 * @module daemon/fallback
 * @role Direct Claude CLI invocation when Core is down.
 * @responsibilities
 *   - Call claude CLI directly as emergency fallback
 *   - Include Core error context so Claude can help diagnose
 * @dependencies shared/config
 * @effects Spawns claude CLI process
 * @contract fallbackClaude(message, coreError?) => Promise<string>
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";

const log = createLogger("daemon");

export async function fallbackClaude(message: string, coreError?: string): Promise<string> {
  const systemContext = coreError
    ? `[System: Core process is down. Error: ${coreError}. You are running in fallback mode from Daemon. The user's project is at ${config.projectDir}. Respond to the user normally. If they ask about the error, explain what you see.]\n\n`
    : `[System: Core process is down. You are running in fallback mode from Daemon. The user's project is at ${config.projectDir}. Respond to the user normally.]\n\n`;

  const prompt = systemContext + message;

  try {
    log.warn("Using fallback Claude CLI");
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
    }, config.claudeTimeout);

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      log.error(`Fallback Claude CLI failed (exit=${exitCode}): ${stderr.slice(0, 500)}`);
      return "[Fallback mode] Claude CLI failed. Core is down and fallback is unavailable. Please check server logs.";
    }

    return output.trim() || "[Fallback mode] Empty response from Claude CLI.";
  } catch (error) {
    log.error(`Fallback Claude CLI error: ${error}`);
    return "[Fallback mode] Could not reach Claude CLI. Core is down and fallback is unavailable. Please check server logs.";
  }
}
