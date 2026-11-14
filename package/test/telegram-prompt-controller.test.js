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

function automationHarness({ result, isolateAutomations = true }) {
  const events = { isolated: [], notes: [], replies: [], chatPrompts: 0 };
  const parentSession = {
    messages: [],
    model: { provider: "test", id: "test" },
    subscribe: () => () => {},
    prompt: async () => { events.chatPrompts += 1; },
    sendCustomMessage: async (message) => events.notes.push(message)
  };
  const { controller } = createController({
    config: {
      pi: { speed: 1, chatModels: {}, subagents: { isolateAutomations, parentNoteMaxChars: 40 } },
      telegram: {}
    },
    agentManager: {
      resetSession: () => {},
      runTurn: async (_options, work) => work(),
      runIsolatedAutomation: async (options) => {
        events.isolated.push(options);
        return result;
      },
      getSessionContext: async () => ({ session: parentSession, speedController: { setSpeed() {} }, release: async () => {} })
    },
    sendTextReply: async ({ text }) => events.replies.push(text)
  });
  return { controller, events };
}

test("runs automation prompts in an isolated subagent and leaves the chat session a bounded note", async () => {
  const report = "Deploy de trunks terminado sin errores, 3 archivos actualizados.";
  const { controller, events } = automationHarness({
    result: { subagentId: "abc12345", status: "completed", report, modelCalls: 4 }
  });

  await controller.processPromptForChat({ chatId: "42", prompt: "Scheduled task fired.\ntaskId: t-1\ntext: deploy" });

  assert.equal(events.isolated.length, 1);
  assert.equal(events.isolated[0].sessionKey, "42");
  assert.equal(events.chatPrompts, 0);
  assert.deepEqual(events.replies, [report]);
  assert.equal(events.notes.length, 1);
  assert.equal(events.notes[0].customType, "arisa-automation-report");
  assert.match(events.notes[0].content, /Scheduled task fired\. taskId: t-1/);
  assert.match(events.notes[0].content, /\nDeploy de trunks terminado sin errores,…$/);
});

test("a silent isolated automation delivers nothing and leaves no note", async () => {
  const { controller, events } = automationHarness({
    result: { subagentId: "abc12345", status: "completed", report: "", modelCalls: 1 }
  });

  await controller.processPromptForChat({ chatId: "42", prompt: "External event arrived.\ntaskId: e-1" });

  assert.deepEqual(events.replies, []);
  assert.deepEqual(events.notes, []);
});

test("an automation subagent stopped by its limits fails the task as outcome-uncertain", async () => {
  const { controller } = automationHarness({
    result: { subagentId: "abc12345", status: "stopped", stopReason: "max_model_calls", report: "", modelCalls: 80 }
  });

  await assert.rejects(
    controller.processPromptForChat({ chatId: "42", prompt: "Scheduled task fired.\ntaskId: t-1" }),
    (error) => /max_model_calls/.test(error.message) && error.outcomeUncertain === true && error.retryable === false
  );
});

test("user messages and disabled isolation keep using the chat session", async () => {
  const user = automationHarness({ result: null });
  await user.controller.processPromptForChat({ chatId: "42", prompt: "Incoming Telegram message.\nhola" });
  assert.equal(user.events.isolated.length, 0);
  assert.equal(user.events.chatPrompts, 1);

  const disabled = automationHarness({ result: null, isolateAutomations: false });
  await disabled.controller.processPromptForChat({ chatId: "42", prompt: "Scheduled task fired.\ntaskId: t-1" });
  assert.equal(disabled.events.isolated.length, 0);
  assert.equal(disabled.events.chatPrompts, 1);
});
