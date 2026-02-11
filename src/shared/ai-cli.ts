/**
 * @module shared/ai-cli
 * @role Resolve agent CLI binaries and execute them via Bun runtime.
 */

export type AgentCliName = "claude" | "codex";

export function resolveAgentCliPath(cli: AgentCliName): string | null {
  return Bun.which(cli);
}

export function isAgentCliInstalled(cli: AgentCliName): boolean {
  return resolveAgentCliPath(cli) !== null;
}

export function buildBunWrappedAgentCliCommand(cli: AgentCliName, args: string[]): string[] {
  const cliPath = resolveAgentCliPath(cli);
  if (!cliPath) {
    throw new Error(`${cli} CLI not found in PATH`);
  }
  return ["bun", "--bun", cliPath, ...args];
}
