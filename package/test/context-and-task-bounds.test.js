import assert from "node:assert/strict";
import test from "node:test";
import { collectText, createChatStateStore, drainChatPromptQueue, isSilentReply } from "../src/transport/telegram/bot.js";
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

test("recognizes standalone silent reply markers", () => {
  assert.equal(isSilentReply("NO_REPLY"), true);
  assert.equal(isSilentReply("No reply needed."), true);
  assert.equal(isSilentReply("No action needed."), true);
  assert.equal(isSilentReply("\nNO_REPLY\n\nNO_REPLY\n"), true);
  assert.equal(isSilentReply("No reply needed.\n\nNo action needed."), true);
});

test("does not suppress real text that mentions a silent reply marker", () => {
  assert.equal(isSilentReply("NO_REPLY means no notification was needed."), false);
  assert.equal(isSilentReply("NO_REPLY\n\nThere is an important message."), false);
  assert.equal(isSilentReply("No action needed unless the token expires."), false);
  assert.equal(isSilentReply("No reply needed"), false);
  assert.equal(isSilentReply("no_reply"), false);
  assert.equal(isSilentReply(""), false);
});

test("chat state uses one queue for numeric and string chat IDs", () => {
  const states = createChatStateStore();
  const telegramState = states.get(879964957);
  telegramState.processing = true;
  telegramState.nextPrompt = "queued prompt";

  assert.strictEqual(states.get("879964957"), telegramState);
  assert.equal(states.get("879964957").processing, true);
  assert.equal(states.get("879964957").nextPrompt, "queued prompt");

  const resetState = states.reset("879964957");
  assert.strictEqual(states.get(879964957), resetState);
  assert.deepEqual(resetState, {
    processing: false,
    nextPrompt: "",
    continueAfterClose: false,
    historyRevision: 0,
    beforeNextPrompt: null
  });
});

test("a queued /new continues after the active session closes", async () => {
  const chatState = { processing: true, nextPrompt: "", continueAfterClose: false };
  const processed = [];
  const interruption = new Error("active session closed");

  await drainChatPromptQueue({
    chatState,
    initialPrompt: "old request",
    processPrompt: async ({ prompt }) => {
      processed.push(prompt);
      if (prompt === "old request") {
        chatState.nextPrompt = "new session confirmation";
        chatState.continueAfterClose = true;
        throw interruption;
      }
    }
  });

  assert.deepEqual(processed, ["old request", "new session confirmation"]);
  assert.deepEqual(chatState, { processing: false, nextPrompt: "", continueAfterClose: false });
});

test("exclusive pre-prompt work keeps concurrent messages queued", async () => {
  const chatState = { processing: true, nextPrompt: "", continueAfterClose: false, beforeNextPrompt: null };
  const processed = [];
  let releasePreparation;
  const preparation = new Promise((resolve) => { releasePreparation = resolve; });

  const draining = drainChatPromptQueue({
    chatState,
    initialPrompt: "new session confirmation",
    beforeInitialPrompt: () => preparation,
    processPrompt: async ({ prompt }) => processed.push(prompt)
  });
  await new Promise((resolve) => setImmediate(resolve));
  chatState.nextPrompt = "message received during handoff";
  releasePreparation();
  await draining;

  assert.deepEqual(processed, ["new session confirmation", "message received during handoff"]);
  assert.equal(chatState.processing, false);
});

test("a queued /new supersedes the initial prompt after exclusive preparation", async () => {
  const chatState = { processing: true, nextPrompt: "", continueAfterClose: false, beforeNextPrompt: null };
  const processed = [];
  let releasePreparation;
  const preparation = new Promise((resolve) => { releasePreparation = resolve; });

  const draining = drainChatPromptQueue({
    chatState,
    initialPrompt: "first new session confirmation",
    beforeInitialPrompt: () => preparation,
    processPrompt: async ({ prompt }) => processed.push(prompt)
  });
  await new Promise((resolve) => setImmediate(resolve));
  chatState.nextPrompt = "latest new session confirmation";
  chatState.continueAfterClose = true;
  releasePreparation();
  await draining;

  assert.deepEqual(processed, ["latest new session confirmation"]);
  assert.equal(chatState.processing, false);
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
