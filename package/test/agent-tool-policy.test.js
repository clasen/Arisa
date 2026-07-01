import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPiToolPolicy } from "../src/core/agent/core-tools.js";
import { appendArisaAgentsFile, arisaAgentsFile } from "../src/core/agent/runtime-context.js";
import { createSystemShellTool } from "../src/core/agent/system-shell-tool.js";
import { applyRuntimeOverrides } from "../src/runtime/create-app.js";
import { arisaHomeDir } from "../src/runtime/paths.js";

test("builds default Pi tool policy for the Arisa home workspace", () => {
  const policy = buildPiToolPolicy({ config: { pi: {} } });

  assert.equal(policy.workspaceDir, path.resolve(arisaHomeDir));
  assert.equal(policy.tools, undefined);
  assert.equal(policy.excludeTools, undefined);
  assert.deepEqual(
    policy.coreTools.filter((tool) => tool.enabled).map((tool) => tool.name),
    ["read", "bash", "edit", "write"]
  );
});

test("keeps Arisa custom tools available when pi.tools is configured", () => {
  const policy = buildPiToolPolicy({
    config: {
      pi: {
        tools: "read,bash",
        excludeTools: "bash",
        workspaceDir: "~/arisa-workspace",
        shellTimeoutMs: "120000"
      }
    },
    customToolNames: ["run_tool", "system_shell"]
  });

  assert.deepEqual(policy.tools, ["read", "bash", "run_tool", "system_shell"]);
  assert.deepEqual(policy.excludeTools, ["bash"]);
  assert.equal(policy.shell.timeoutMs, 120000);
  assert.equal(policy.workspaceDir, path.join(os.homedir(), "arisa-workspace"));
  assert.deepEqual(
    policy.coreTools.filter((tool) => tool.enabled).map((tool) => tool.name),
    ["read"]
  );
});

test("applies runtime overrides without dropping persisted Pi config", () => {
  const config = {
    telegram: { token: "token" },
    pi: {
      provider: "openai-codex",
      model: "gpt-5.5",
      apiKey: "persisted"
    }
  };

  const next = applyRuntimeOverrides(config, {
    pi: {
      model: "anthropic/claude-opus-4-5",
      workspaceDir: "/tmp/arisa",
      tools: "read,bash",
      excludeTools: "write",
      shellTimeoutMs: "90000"
    }
  });

  assert.equal(next.pi.provider, "anthropic");
  assert.equal(next.pi.model, "claude-opus-4-5");
  assert.equal(next.pi.apiKey, "persisted");
  assert.equal(next.pi.workspaceDir, "/tmp/arisa");
  assert.deepEqual(next.pi.tools, ["read", "bash"]);
  assert.deepEqual(next.pi.excludeTools, ["write"]);
  assert.equal(next.pi.shellTimeoutMs, 90000);
});

test("system_shell runs commands from the configured workspace", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "arisa-shell-"));
  const tool = createSystemShellTool({
    workspaceDir,
    shell: { timeoutMs: 10_000 }
  });

  const result = await tool.execute("call-1", {
    command: "node -e \"process.stdout.write(process.cwd())\""
  });

  const realWorkspaceDir = await realpath(workspaceDir);
  assert.equal(result.isError, false);
  assert.equal(result.details.cwd, workspaceDir);
  assert.equal(result.details.exitCode, 0);
  assert.equal(result.details.stdout, realWorkspaceDir);
});

test("adds Arisa AGENTS.md to Pi context files without duplicating it", () => {
  const current = {
    agentsFiles: [
      { path: "/workspace/AGENTS.md", content: "# Workspace" },
      { path: arisaAgentsFile, content: "old" }
    ],
    diagnostics: []
  };

  const next = appendArisaAgentsFile(current, "# Arisa AGENTS");

  assert.deepEqual(next.diagnostics, []);
  assert.deepEqual(
    next.agentsFiles.map((file) => file.path),
    ["/workspace/AGENTS.md", arisaAgentsFile]
  );
  assert.equal(next.agentsFiles.at(-1).content, "# Arisa AGENTS");
});
