import assert from "node:assert/strict";
import test from "node:test";
import {
  collectText,
  ensureQueuedTelegramTyping,
  isSilentReply,
  resolveIncomingBusyMessageMode,
  stopQueuedTelegramTyping
} from "../src/transport/telegram/bot.js";
import {
  createChatStateStore,
  drainChatPromptQueue,
  queueChatPrompt,
  resolveTelegramBusyMessageMode,
  routeBusyPrompt
} from "../src/transport/telegram/chat-queue.js";
import { selectScheduledTasks } from "../src/core/capabilities/capability-service.js";

test("queued Telegram prompts start typing immediately and share one indicator", async () => {
  let actions = 0;
  const chatState = { stopQueuedTyping: null };
  const ctx = {
    chat: { id: 879964957 },
    api: {
      async sendChatAction(chatId, action) {
        assert.equal(chatId, 879964957);
        assert.equal(action, "typing");
        actions += 1;
      }
    }
  };

  await ensureQueuedTelegramTyping(chatState, ctx);
  await ensureQueuedTelegramTyping(chatState, ctx);
  assert.equal(actions, 1);
  assert.equal(typeof chatState.stopQueuedTyping, "function");

  stopQueuedTelegramTyping(chatState);
  assert.equal(chatState.stopQueuedTyping, null);
});

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

test("collectText drops a standalone silent event reply before a steered response", async () => {
  const session = createSession([
    { type: "message_start", message: { role: "assistant" } },
    {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "NO_REPLY" }
    },
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    { type: "message_start", message: { role: "assistant" } },
    {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "The useful Telegram response." }
    },
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } }
  ]);

  assert.equal(await collectText(session, "event followed by a Telegram steer"), "The useful Telegram response.");
});

test("collectText preserves useful text in the same message as a silent marker", async () => {
  const session = createSession([
    { type: "message_start", message: { role: "assistant" } },
    {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "NO_REPLY\n\nThis text belongs to the same response." }
    },
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } }
  ]);

  assert.equal(
    await collectText(session, "one response that mentions the marker"),
    "NO_REPLY\n\nThis text belongs to the same response."
  );
});

test("recognizes standalone silent reply markers", () => {
  assert.equal(isSilentReply("NO_REPLY"), true);
  assert.equal(isSilentReply("SILENT_REPLY"), true);
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
  queueChatPrompt(telegramState, "queued prompt");

  assert.strictEqual(states.get("879964957"), telegramState);
  assert.equal(states.get("879964957").processing, true);
  assert.deepEqual(states.get("879964957").pendingPrompts, ["queued prompt"]);

  const resetState = states.reset("879964957");
  assert.strictEqual(states.get(879964957), resetState);
  assert.deepEqual(resetState, {
    processing: false,
    pendingPrompts: [],
    pendingPromptContexts: [],
    pendingPromptReceipts: [],
    pendingPromptCoalescible: [],
    continueAfterClose: false,
    historyRevision: 0,
    beforeNextPrompt: null,
    activeSession: null,
    assistantMessages: new Map(),
    stopQueuedTyping: null
  });
});

test("queued prompts retain their message boundaries and order", async () => {
  const chatState = createChatStateStore().get("chat");
  chatState.processing = true;
  queueChatPrompt(chatState, "second request");
  queueChatPrompt(chatState, "third request");
  const processed = [];

  await drainChatPromptQueue({
    chatState,
    initialPrompt: "first request",
    processPrompt: async ({ prompt }) => processed.push(prompt)
  });

  assert.deepEqual(processed, ["first request", "second request", "third request"]);
});

test("queued execution receipts resolve only after their prompt runs", async () => {
  const chatState = createChatStateStore().get("chat");
  chatState.processing = true;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const { createPromptExecutionReceipt } = await import("../src/transport/telegram/chat-queue.js");
  const receipt = createPromptExecutionReceipt();
  queueChatPrompt(chatState, "scheduled request", { receipt });
  let confirmed = false;
  receipt.promise.then(() => { confirmed = true; });

  const draining = drainChatPromptQueue({
    chatState,
    initialPrompt: "active request",
    processPrompt: async ({ prompt }) => {
      if (prompt === "active request") await firstGate;
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(confirmed, false);
  releaseFirst();
  await receipt.promise;
  assert.equal(confirmed, true);
  await draining;
});

test("a queued /new continues after the active session closes", async () => {
  const chatState = createChatStateStore().get("chat");
  chatState.processing = true;
  const processed = [];
  const interruption = new Error("active session closed");

  await drainChatPromptQueue({
    chatState,
    initialPrompt: "old request",
    processPrompt: async ({ prompt }) => {
      processed.push(prompt);
      if (prompt === "old request") {
        queueChatPrompt(chatState, "new session confirmation", { replace: true });
        chatState.continueAfterClose = true;
        throw interruption;
      }
    }
  });

  assert.deepEqual(processed, ["old request", "new session confirmation"]);
  assert.equal(chatState.processing, false);
  assert.deepEqual(chatState.pendingPrompts, []);
});

test("exclusive pre-prompt work keeps concurrent messages queued", async () => {
  const chatState = createChatStateStore().get("chat");
  chatState.processing = true;
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
  queueChatPrompt(chatState, "message received during handoff");
  releasePreparation();
  await draining;

  assert.deepEqual(processed, ["new session confirmation", "message received during handoff"]);
  assert.equal(chatState.processing, false);
});

test("a queued /new supersedes the initial prompt after exclusive preparation", async () => {
  const chatState = createChatStateStore().get("chat");
  chatState.processing = true;
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
  queueChatPrompt(chatState, "latest new session confirmation", { replace: true });
  chatState.continueAfterClose = true;
  releasePreparation();
  await draining;

  assert.deepEqual(processed, ["latest new session confirmation"]);
  assert.equal(chatState.processing, false);
});

test("busy message mode supports global defaults and per-chat overrides", () => {
  const config = {
    telegram: {
      busyMessageMode: "queue",
      chatMeta: { "879964957": { busyMessageMode: "steer" } }
    }
  };

  assert.equal(resolveTelegramBusyMessageMode(config, 879964957), "steer");
  assert.equal(resolveTelegramBusyMessageMode(config, 123), "queue");
  assert.equal(resolveTelegramBusyMessageMode({ telegram: { busyMessageMode: "invalid" } }, 123), "queue");
});

test("forum topics queue while direct Arisa messages retain steer mode", () => {
  const config = { telegram: { busyMessageMode: "steer", chatMeta: {} } };
  assert.equal(resolveIncomingBusyMessageMode({
    config,
    route: { workspace: true, sessionId: "owner--topic-87" },
    message: { text: "topic follow-up" }
  }), "queue");
  assert.equal(resolveIncomingBusyMessageMode({
    config,
    route: { workspace: false, sessionId: "879964957" },
    message: { text: "direct follow-up" }
  }), "steer");
});

test("steer mode sends text to the active Pi session", async () => {
  const received = [];
  const chatState = createChatStateStore().get("chat");
  chatState.activeSession = {
    isStreaming: true,
    async steer(prompt) { received.push(prompt); }
  };

  const result = await routeBusyPrompt({ chatState, prompt: "change direction", mode: "steer" });

  assert.equal(result.disposition, "steered");
  assert.deepEqual(received, ["change direction"]);
  assert.deepEqual(chatState.pendingPrompts, []);
});

test("failed or unavailable steering falls back to the ordered queue", async () => {
  const chatState = createChatStateStore().get("chat");
  chatState.activeSession = {
    isStreaming: true,
    async steer() { throw new Error("stream ended"); }
  };

  const failed = await routeBusyPrompt({ chatState, prompt: "keep this", mode: "steer" });
  chatState.activeSession = null;
  const unavailable = await routeBusyPrompt({ chatState, prompt: "and this", mode: "steer" });

  assert.equal(failed.disposition, "queued");
  assert.match(failed.steerError.message, /stream ended/);
  assert.equal(unavailable.disposition, "queued");
  assert.deepEqual(chatState.pendingPrompts, ["keep this", "and this"]);
});

test("direct steer fallback coalesces consecutive text without reordering it", async () => {
  const steered = [];
  const chatState = createChatStateStore().get("chat");

  const unavailable = await routeBusyPrompt({
    chatState,
    prompt: "first direct message",
    mode: "steer",
    coalesceQueued: true,
    ctx: { message: { message_id: 1 } }
  });
  chatState.activeSession = {
    isStreaming: true,
    async steer(prompt) { steered.push(prompt); }
  };
  const next = await routeBusyPrompt({
    chatState,
    prompt: "second direct message",
    mode: "steer",
    coalesceQueued: true,
    ctx: { message: { message_id: 2 } }
  });

  assert.equal(unavailable.disposition, "queued");
  assert.equal(next.disposition, "coalesced");
  assert.deepEqual(steered, []);
  assert.deepEqual(chatState.pendingPrompts, [
    "first direct message\n\n--- next direct message ---\n\nsecond direct message"
  ]);
  assert.equal(chatState.pendingPromptContexts[0].message.message_id, 2);
});

test("a pending /new forces later text into the replacement queue", async () => {
  const steered = [];
  const chatState = createChatStateStore().get("chat");
  chatState.continueAfterClose = true;
  chatState.activeSession = {
    isStreaming: true,
    async steer(prompt) { steered.push(prompt); }
  };
  queueChatPrompt(chatState, "new session confirmation", { replace: true });

  const result = await routeBusyPrompt({ chatState, prompt: "message after new", mode: "steer" });

  assert.equal(result.disposition, "queued");
  assert.deepEqual(steered, []);
  assert.deepEqual(chatState.pendingPrompts, ["new session confirmation", "message after new"]);
});

test("selectScheduledTasks bounds history while keeping active tasks", () => {
  const tasks = Array.from({ length: 55 }, (_, index) => ({
    id: `done-${index}`,
    status: "done"
  }));
  tasks[0] = { id: "pending-1", status: "pending" };
  tasks[1] = { id: "blocked-1", status: "blocked_auth" };

  const result = selectScheduledTasks(tasks);

  assert.equal(result.total, 55);
  assert.equal(result.returned, 50);
  assert.equal(result.limit, 50);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.tasks.slice(0, 2).map((task) => task.id), ["blocked-1", "pending-1"]);
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
