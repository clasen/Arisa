import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramTaskDispatcher } from "../src/transport/telegram/task-dispatcher.js";

function createHarness(overrides = {}) {
  const calls = [];
  const taskStore = {
    async fail(...args) { calls.push(["fail", ...args]); },
    async complete(...args) { calls.push(["complete", ...args]); },
    async claimDue() { return []; },
    ...overrides.taskStore
  };
  const dispatcher = createTelegramTaskDispatcher({
    taskStore,
    sendMessage: async (...args) => calls.push(["send", ...args]),
    enqueueAsyncPrompt: async (input) => calls.push(["enqueue", input]),
    artifactStore: { forChat() { throw new Error("unexpected artifact access"); } },
    toolRegistry: {},
    resourceNotes: { async get() { return ""; } },
    agentManager: { async runTool(input) { calls.push(["runTool", input]); } },
    logger: null,
    ...overrides.dependencies
  });
  return { calls, taskStore, dispatcher };
}

test("dispatches an agent task into the Telegram prompt queue", async () => {
  const { calls, dispatcher } = createHarness();
  await dispatcher.dispatchTask({
    id: "task-1",
    kind: "agent_task",
    payload: { chatId: 123, prompt: "do the thing", telegramContext: { messageThreadId: 9 } }
  });

  assert.equal(calls[0][0], "enqueue");
  assert.equal(calls[0][1].chatId, 123);
  assert.match(calls[0][1].prompt, /taskId: task-1/);
  assert.match(calls[0][1].prompt, /text: do the thing/);
  assert.deepEqual(calls[1], ["complete", "task-1"]);
});

test("acknowledges an agent event before queueing it", async () => {
  const { calls, dispatcher } = createHarness();
  await dispatcher.dispatchTask({
    id: "event-1",
    kind: "agent_event",
    payload: { chatId: 123, prompt: "something happened", acknowledgement: "received" }
  });

  assert.deepEqual(calls[0], ["send", 123, "received"]);
  assert.equal(calls[1][0], "enqueue");
  assert.match(calls[1][1].prompt, /event: something happened/);
  assert.deepEqual(calls[2], ["complete", "event-1"]);
});

test("runs poll tools headlessly and completes the checker task", async () => {
  const { calls, dispatcher } = createHarness();
  await dispatcher.dispatchTask({
    id: "poll-1",
    kind: "poll_tool",
    payload: { chatId: 123, toolName: "checker", args: { cursor: "4" } }
  });

  assert.deepEqual(calls, [
    ["runTool", { name: "checker", request: { args: { cursor: "4" } }, chatId: 123 }],
    ["complete", "poll-1"]
  ]);
});

test("fails malformed and unsupported tasks without enqueueing them", async () => {
  const { calls, dispatcher } = createHarness();
  await dispatcher.dispatchTask({ id: "bad-1", kind: "agent_task", payload: {} });
  await dispatcher.dispatchTask({ id: "bad-2", kind: "other", payload: { chatId: 123 } });

  assert.deepEqual(calls, [
    ["fail", "bad-1", "Task missing chatId: agent_task"],
    ["fail", "bad-2", "Unsupported task: other"]
  ]);
});

test("due-task dispatch isolates failures between claimed tasks", async () => {
  const tasks = [
    { id: "bad", kind: "agent_task", payload: { chatId: 123, prompt: "fail" } },
    { id: "good", kind: "poll_tool", payload: { chatId: 123, toolName: "checker" } }
  ];
  const { calls, dispatcher } = createHarness({
    taskStore: { async claimDue(limit) { calls.push(["claimDue", limit]); return tasks; } },
    dependencies: {
      enqueueAsyncPrompt: async () => { throw new Error("queue unavailable"); }
    }
  });

  await dispatcher.dispatchDueTasks();

  assert.deepEqual(calls, [
    ["claimDue", 10],
    ["fail", "bad", "queue unavailable"],
    ["runTool", { name: "checker", request: { args: {} }, chatId: 123 }],
    ["complete", "good"]
  ]);
});
