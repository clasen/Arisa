import assert from "node:assert/strict";
import test from "node:test";
import { createChatStateStore } from "../src/transport/telegram/chat-queue.js";
import { createTelegramPromptController } from "../src/transport/telegram/telegram-prompt-controller.js";

function createController(overrides = {}) {
  const stateStore = createChatStateStore();
  const calls = { cleared: [], reset: [], steered: [] };
  const controller = createTelegramPromptController({
    config: { pi: { chatModels: {} }, telegram: {} },
    api: {},
    artifactStore: {},
    toolRegistry: {},
    agentManager: {
      resetSession: (...args) => calls.reset.push(args),
      runTurn: async (_options, work) => work()
    },
    sessionSeeds: {
      clear: async (chatId) => calls.cleared.push(chatId)
    },
    workspaceTopics: {},
    contextRoute: (ctx) => ctx.route,
    getChatState: (chatId) => stateStore.get(chatId),
    createTelegramSessionBridge: () => ({}),
    createWorkspaceAccessGuard: () => async () => {},
    sendTextReply: async () => {},
    authController: { notifyIssueIfNeeded: async () => false },
    ensureWorkspaceTopicModelSelection: async () => {},
    ensureQueuedTyping: async () => {},
    withTyping: async (_ctx, work) => work(),
    resolveBusyMessageMode: () => "steer",
    ...overrides
  });
  return { controller, stateStore, calls };
}

test("busy /new resets only the active session and replaces its queued prompt", async () => {
  const { controller, stateStore, calls } = createController();
  const route = {
    workspace: true,
    sessionId: "topic-87",
    scopeChatId: "owner",
    transportChatId: "group",
    threadId: 87
  };
  const state = stateStore.get(route.sessionId);
  state.processing = true;
  state.pendingPrompts.push("stale prompt");

  await controller.handleNewCommand({ route, from: { language_code: "es" } });

  assert.deepEqual(calls.cleared, [route.sessionId]);
  assert.deepEqual(calls.reset, [[route.sessionId]]);
  assert.equal(state.pendingPrompts.length, 1);
  assert.match(state.pendingPrompts[0], /System event: \/new requested/);
  assert.equal(state.continueAfterClose, true);
});

test("a busy prompt for another topic queues instead of steering the active session", async () => {
  const { controller, stateStore, calls } = createController();
  const state = stateStore.get("topic-session");
  state.processing = true;
  state.activeRoute = { transportChatId: "group", threadId: 87 };
  state.activeSession = {
    isStreaming: true,
    steer: async (prompt) => calls.steered.push(prompt)
  };
  const ctx = {
    route: { transportChatId: "group", threadId: 114 }
  };

  await controller.enqueuePrompt({
    chatId: "topic-session",
    prompt: "different destination",
    label: "cross-topic prompt",
    ctx,
    busyMessageMode: "steer"
  });

  assert.deepEqual(calls.steered, []);
  assert.deepEqual(state.pendingPrompts, ["different destination"]);
});
