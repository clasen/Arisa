import test from "node:test";
import assert from "node:assert/strict";
import { createTuiCapabilityTools, resolveTuiChatId } from "../src/runtime/tui.js";

test("uses the first authorized owner scope for TUI capabilities", () => {
  assert.equal(resolveTuiChatId({ telegram: { authorizedChatIds: [879964957, 2] } }), 879964957);
  assert.throws(() => resolveTuiChatId({ telegram: { authorizedChatIds: [] } }), /authorized chat/);
});

test("adapts Pi TUI tools to the running Arisa IPC service", async () => {
  const calls = [];
  const client = {
    tools: {
      list: async (params) => { calls.push(["list", params]); return { tools: [] }; },
      help: async () => "help",
      skills: async () => [],
      setConfig: async () => ({ ok: true }),
      run: async () => ({ ok: true })
    },
    tasks: {
      list: async () => [],
      cancel: async () => ({ ok: true }),
      cancelAll: async () => ({ ok: true })
    }
  };
  const tools = createTuiCapabilityTools(client);
  assert.deepEqual(tools.map((tool) => tool.name), [
    "list_tools",
    "tool_help",
    "tool_skills",
    "set_tool_config",
    "run_tool",
    "list_scheduled_tasks",
    "cancel_scheduled_task",
    "cancel_all_scheduled_tasks"
  ]);

  const result = await tools[0].execute("call", { query: "email" });
  assert.deepEqual(calls, [["list", { query: "email" }]]);
  assert.match(result.content[0].text, /"tools"/);
});
