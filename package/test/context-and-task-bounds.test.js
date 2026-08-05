import assert from "node:assert/strict";
import test from "node:test";
import { collectText } from "../src/transport/telegram/bot.js";
import { selectScheduledTasks } from "../src/core/agent/agent-manager.js";

function createSession(events) {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      for (const event of events) {
        for (const listener of listeners) listener(event);
      }
    }
  };
}

test("collectText ignores a transient error after a successful retry", async () => {
  const session = createSession([
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Codex error: Your input exceeds the context window of this model."
      }
    },
    { type: "message_start", message: { role: "assistant" } },
    {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Recovered response" }
    },
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } }
  ]);

  assert.equal(await collectText(session, "hello"), "Recovered response");
});

test("collectText preserves the final assistant error", async () => {
  const session = createSession([
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "terminal failure" }
    }
  ]);

  await assert.rejects(() => collectText(session, "hello"), /terminal failure/);
});

test("selectScheduledTasks bounds history while keeping active tasks", () => {
  const tasks = Array.from({ length: 55 }, (_, index) => ({
    id: `done-${index}`,
    status: "done"
  }));
  tasks[0] = { id: "pending-1", status: "pending" };

  const result = selectScheduledTasks(tasks);

  assert.equal(result.total, 55);
  assert.equal(result.returned, 50);
  assert.equal(result.limit, 50);
  assert.equal(result.truncated, true);
  assert.equal(result.tasks[0].id, "pending-1");
});

test("selectScheduledTasks honors an explicit status and limit", () => {
  const tasks = [
    { id: "done-1", status: "done" },
    { id: "done-2", status: "done" }
  ];

  const result = selectScheduledTasks(tasks, { status: "done", limit: 1 });

  assert.deepEqual(result.tasks.map((task) => task.id), ["done-2"]);
  assert.equal(result.total, 2);
  assert.equal(result.returned, 1);
  assert.equal(result.limit, 1);
  assert.equal(result.truncated, true);
});
