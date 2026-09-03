import assert from "node:assert/strict";
import test from "node:test";
import { createPiCapabilityTools } from "../src/core/agent/pi-capability-tools.js";

function createHarness() {
  const calls = [];
  let taskContext = { transportChatId: "chat-1", messageThreadId: 10 };
  const agentTaskExecution = { blockedAuth: null };
  const capabilityService = {
    async execute(request) {
      calls.push(request);
      if (request.method === "tools.list") return { tools: [] };
      if (request.method === "tools.run") return { ok: true, output: {} };
      return { ok: true };
    }
  };
  const telegram = {
    getTaskContext: () => taskContext,
    getAgentTaskExecution: () => agentTaskExecution,
    sendMedia: async () => {}
  };
  const tools = createPiCapabilityTools({
    capabilityService,
    telegram,
    chatId: "session-1",
    policy: {
      workspaceDir: "/workspace",
      tools: ["read"],
      excludeTools: [],
      shell: {}
    }
  });
  return {
    calls,
    tools,
    setTaskContext(value) {
      taskContext = value;
    }
  };
}

test("Pi tools delegate capability policy to CapabilityService", async () => {
  const harness = createHarness();
  const listTools = harness.tools.find((tool) => tool.name === "list_tools");

  await listTools.execute("call-1", { query: "audio" });

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].method, "tools.list");
  assert.equal(harness.calls[0].actorToolName, "list_tools");
  assert.equal(harness.calls[0].chatId, "session-1");
  assert.equal(harness.calls[0].context.workspaceDir, "/workspace");
  assert.equal(harness.calls[0].context.coreTools[0].name, "read");
  assert.equal(harness.calls[0].context.nativeTools[0].name, "system_shell");
});

test("Pi tool execution resolves the current Telegram task context per call", async () => {
  const harness = createHarness();
  const runTool = harness.tools.find((tool) => tool.name === "run_tool");

  await runTool.execute("call-1", { name: "worker", args: {} });
  harness.setTaskContext({ transportChatId: "chat-1", messageThreadId: 20 });
  await runTool.execute("call-2", { name: "worker", args: {} });

  assert.equal(harness.calls[0].context.taskContext.messageThreadId, 10);
  assert.equal(harness.calls[1].context.taskContext.messageThreadId, 20);
  assert.equal(harness.calls[0].context.agentTaskExecution, harness.calls[1].context.agentTaskExecution);
});
