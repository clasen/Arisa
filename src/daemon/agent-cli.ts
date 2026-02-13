/**
 * @module daemon/agent-cli
 * @role Run AI CLI commands directly from Daemon with local fallback order.
 * @responsibilities
 *   - Detect available CLIs (Claude, Codex)
 *   - Execute prompt with timeout
 *   - Fallback from Claude to Codex when needed
 * @dependencies shared/config
 * @effects Spawns external CLI processes
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import {
  buildBunWrappedAgentCliCommand,
  resolveAgentCliPath,
  type AgentCliName,
} from "../shared/ai-cli";

const log = createLogger("daemon");

export type AgentCli = AgentCliName;

export interface CliExecutionResult {
  cli: AgentCli;
  output: string;
  stderr: string;
  exitCode: number;
  partial: boolean;
}

export interface CliFallbackOutcome {
  result: CliExecutionResult | null;
  attempted: AgentCli[];
  failures: string[];
}

export function getAvailableAgentCli(): AgentCli[] {
  const order: AgentCli[] = [];
  if (resolveAgentCliPath("claude") !== null) order.push("claude");
  if (resolveAgentCliPath("codex") !== null) order.push("codex");
  return order;
}

export function getAgentCliLabel(cli: AgentCli): string {
  return cli === "claude" ? "Claude" : "Codex";
}

function buildCommand(cli: AgentCli, prompt: string): string[] {
  if (cli === "claude") {
    return buildBunWrappedAgentCliCommand(
      "claude",
      ["--dangerously-skip-permissions", "--model", "sonnet", "-p", prompt],
    );
  }
  return buildBunWrappedAgentCliCommand(
    "codex",
    ["exec", "--dangerously-bypass-approvals-and-sandbox", "-C", config.projectDir, prompt],
  );
}

async function runSingleCli(
  cli: AgentCli,
  prompt: string,
  timeoutMs: number,
): Promise<Omit<CliExecutionResult, "partial">> {
  const cmd = buildCommand(cli, prompt);
  log.info(`Daemon AI: trying ${getAgentCliLabel(cli)} CLI`);

  const proc = Bun.spawn(cmd, {
    cwd: config.projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  const [output, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { cli, output, stderr, exitCode };
}

export async function runWithCliFallback(prompt: string, timeoutMs: number): Promise<CliFallbackOutcome> {
  const candidates = getAvailableAgentCli();
  const attempted: AgentCli[] = [];
  const failures: string[] = [];
  let partial: CliExecutionResult | null = null;

  for (const cli of candidates) {
    attempted.push(cli);

    try {
      const result = await runSingleCli(cli, prompt, timeoutMs);
      const output = result.output.trim();

      if (result.exitCode === 0 && output) {
        return {
          result: { ...result, output, partial: false },
          attempted,
          failures,
        };
      }

      if (result.exitCode !== 0 && output && partial === null) {
        partial = { ...result, output, partial: true };
      }

      const reason = result.exitCode === 0
        ? `empty output${result.stderr ? ` (stderr: ${summarizeError(result.stderr)})` : ""}`
        : `exit=${result.exitCode}: ${summarizeError(result.stderr || result.output)}`;
      failures.push(`${getAgentCliLabel(cli)} ${reason}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failures.push(`${getAgentCliLabel(cli)} error: ${summarizeError(msg)}`);
    }
  }

  return { result: partial, attempted, failures };
}

function summarizeError(raw: string): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (!clean) return "no details";
  return clean.length > 200 ? `${clean.slice(0, 200)}...` : clean;
}
