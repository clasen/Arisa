import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramTaskDispatcher } from "../src/transport/telegram/task-dispatcher.js";

function createHarness(overrides = {}) {
  const calls = [];
  const taskStore = {
    async fail(...args) { calls.push(["fail", ...args]); return { status: "failed" }; },
    async complete(...args) { calls.push(["complete", ...args]); return { status: "done" }; },
    async retryOrFail(taskId, error, options) {
      calls.push(["retryOrFail", taskId, error.message, options]);
      return { status: options.retryable ? "pending" : "failed" };
    },
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
    agentManager: { async runTool(input) { calls.push(["runTool", input]); return { ok: true }; } },
    logger: null,
    ...overrides.dependencies
  });
  return { calls, taskStore, dispatcher };
}

test("confirms an agent task only after prompt execution resolves", async () => {
  let confirmExecution;
  const execution = new Promise((resolve) => { confirmExecution = resolve; });
  const { calls, dispatcher } = createHarness({
    dependencies: {
      enqueueAsyncPrompt: async (input) => {
        calls.push(["enqueue", input]);
        await execution;
      }
    }
  });
  const running = dispatcher.runClaimedTask({
    id: "task-1",
    kind: "agent_task",
    status: "running",
    payload: { chatId: 123, prompt: "do the thing" },
    route: { transport: "telegram", destination: { chatId: -1001, threadId: 9 } }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0][0], "enqueue");
  assert.deepEqual(calls[0][1].route, { transport: "telegram", destination: { chatId: -1001, threadId: 9 } });
  assert.equal(calls.some(([name]) => name === "complete"), false);
  confirmExecution();
  await running;
  assert.deepEqual(calls.at(-1), ["complete", "task-1"]);
});

test("acknowledges an agent event before executing it", async () => {
  const { calls, dispatcher } = createHarness();
  await dispatcher.runClaimedTask({
    id: "event-1",
    kind: "agent_event",
    payload: { chatId: 123, prompt: "something happened", acknowledgement: "received" }
  });

  assert.deepEqual(calls[0], ["send", 123, "received"]);
  assert.equal(calls[1][0], "enqueue");
  assert.match(calls[1][1].prompt, /event: something happened/);
  assert.match(calls[1][1].prompt, /return exactly NO_REPLY/);
  assert.deepEqual(calls[2], ["complete", "event-1"]);
});

test("runs poll tools headlessly and confirms their result", async () => {
  const { calls, dispatcher } = createHarness();
  await dispatcher.runClaimedTask({
    id: "poll-1",
    kind: "poll_tool",
    payload: { chatId: 123, toolName: "checker", args: { cursor: "4" } }
  });

  assert.deepEqual(calls, [
    ["runTool", { name: "checker", request: { args: { cursor: "4" } }, chatId: 123 }],
    ["complete", "poll-1"]
  ]);
});

test("retries a known poll failure with backoff", async () => {
  const { calls, dispatcher } = createHarness({
    dependencies: {
      agentManager: {
        async runTool(input) {
          calls.push(["runTool", input]);
          return { ok: false, status: "failed", error: "temporary checker failure" };
        }
      }
    }
  });
  await dispatcher.runClaimedTask({
    id: "poll-failed",
    kind: "poll_tool",
    payload: { chatId: 123, toolName: "checker" }
  });

  assert.deepEqual(calls.at(-1), [
    "retryOrFail",
    "poll-failed",
    "temporary checker failure",
    { retryable: true }
  ]);
});

test("fails malformed tasks without retrying", async () => {
  const { calls, dispatcher } = createHarness();
  await dispatcher.runClaimedTask({ id: "bad-1", kind: "agent_task", payload: {} });
  await dispatcher.runClaimedTask({ id: "bad-2", kind: "other", payload: { chatId: 123 } });

  assert.deepEqual(calls, [
    ["retryOrFail", "bad-1", "Task missing chatId: agent_task", { retryable: false }],
    ["retryOrFail", "bad-2", "Unsupported task: other", { retryable: false }],
    ["send", 123, "⚠️ Arisa task failed\nTask: other (bad-2)\nError: Unsupported task: other\nNo further retries are scheduled.", undefined]
  ]);
});

test("notifies the routed Telegram topic once retries are exhausted", async () => {
  const { calls, dispatcher } = createHarness({
    taskStore: {
      async retryOrFail(taskId, error, options) {
        calls.push(["retryOrFail", taskId, error.message, options]);
        return {
          status: "pending",
          terminalFailure: true,
          runAt: "2026-08-21T00:00:00.000Z"
        };
      }
    },
    dependencies: {
      enqueueAsyncPrompt: async () => { throw new Error("token=very-secret-value queue unavailable"); }
    }
  });

  await dispatcher.runClaimedTask({
    id: "recurring-bad",
    kind: "agent_task",
    payload: { chatId: 123, prompt: "private payload must not appear" },
    route: { transport: "telegram", destination: { chatId: -1001, threadId: 87 } }
  });

  assert.deepEqual(calls.at(-1), [
    "send",
    -1001,
    "⚠️ Arisa task failed\nTask: agent_task (recurring-bad)\nError: token=[redacted] queue unavailable\nNext run: 2026-08-21T00:00:00.000Z",
    { message_thread_id: 87 }
  ]);
  assert.equal(calls.at(-1)[2].includes("private payload"), false);
});

test("due-task dispatch retries one failure without blocking another task", async () => {
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
    ["runTool", { name: "checker", request: { args: {} }, chatId: 123 }],
    ["complete", "good"],
    ["retryOrFail", "bad", "queue unavailable", { retryable: true }]
  ]);
});
