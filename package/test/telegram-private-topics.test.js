import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { resolveIncomingBusyMessageMode } from "../src/transport/telegram/bot.js";
import { createChatStateStore } from "../src/transport/telegram/chat-queue.js";
import { createReplyDraftStream, draftPreview } from "../src/transport/telegram/reply-draft-stream.js";
import {
  buildGeneralReplyRoutingInstruction,
  isGeneralWorkspaceRoute,
  routeGeneralWorkspaceReply
} from "../src/transport/telegram/reply-topic-routing.js";
import { createTelegramPromptController } from "../src/transport/telegram/telegram-prompt-controller.js";
import { createTelegramSessionBridgeController } from "../src/transport/telegram/telegram-session-bridge.js";
import { resolveTelegramWorkspaceRoute } from "../src/transport/telegram/workspace-group.js";
import { WorkspaceTopicStore } from "../src/transport/telegram/workspace-topic-store.js";

const config = { telegram: { ownerWorkspaceGroups: {}, busyMessageMode: "steer" } };

function privateCtx(message = {}) {
  return { chat: { id: 42, type: "private" }, from: { id: 42 }, message };
}

async function topicStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arisa-private-topics-"));
  return {
    store: new WorkspaceTopicStore({ resolveFile: () => path.join(directory, "topics.json") }),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

test("a private chat topic gets an isolated session that shares the chat scope", async () => {
  const route = await resolveTelegramWorkspaceRoute({ config, api: {}, ctx: privateCtx({ message_thread_id: 7 }) });
  assert.equal(route.workspace, true);
  assert.equal(route.privateTopics, true);
  assert.equal(route.sessionId, "42--telegram-private-topic-7");
  assert.equal(route.scopeChatId, 42);
  assert.equal(route.transportChatId, 42);
  assert.equal(route.threadId, 7);
  assert.equal(isGeneralWorkspaceRoute(route), false);
});

test("the main private chat becomes General only when the bot has topics enabled", async () => {
  const plain = await resolveTelegramWorkspaceRoute({ config, api: {}, ctx: privateCtx() });
  assert.equal(plain.workspace, false);
  assert.equal(plain.sessionId, "42");

  const general = await resolveTelegramWorkspaceRoute({ config, api: {}, ctx: privateCtx(), privateTopicsEnabled: true });
  assert.equal(general.sessionId, "42");
  assert.equal(general.threadId, null);
  assert.equal(isGeneralWorkspaceRoute(general), true);
});

test("a reply thread in an unconfigured group never becomes a topic session", async () => {
  const route = await resolveTelegramWorkspaceRoute({
    config,
    api: {},
    ctx: { chat: { id: -100555, type: "supergroup" }, from: { id: 42 }, message: { message_thread_id: 9 } },
    privateTopicsEnabled: true
  });
  assert.equal(route.workspace, false);
  assert.equal(route.sessionId, "-100555");
});

test("General replies in a private chat can be delivered to a registered topic", async () => {
  const general = await resolveTelegramWorkspaceRoute({ config, api: {}, ctx: privateCtx(), privateTopicsEnabled: true });
  const routed = routeGeneralWorkspaceReply({
    route: general,
    text: "Done.\n[[ARISA_REPLY_TOPIC:7]]",
    topics: [{ threadId: 7, name: "Finances" }]
  });
  assert.equal(routed.text, "Done.");
  assert.equal(routed.route.threadId, 7);
  assert.match(buildGeneralReplyRoutingInstruction([], [], { privateTopics: true }), /private chat that has topics enabled/);
});

test("private chats keep the configured busy mode while group workspaces queue", () => {
  const message = { text: "hi" };
  assert.equal(resolveIncomingBusyMessageMode({ config, route: { workspace: true, privateTopics: true, sessionId: "42" }, message }), "steer");
  assert.equal(resolveIncomingBusyMessageMode({ config, route: { workspace: true, sessionId: "42" }, message }), "queue");
});

test("an implicit topic name is tracked until the topic is renamed", async () => {
  const { store, cleanup } = await topicStore();
  try {
    const route = { workspace: true, privateTopics: true, ownerChatId: 42, transportChatId: 42, threadId: 7, topicThreadId: 7, generalTopicId: null };
    await store.observeMessage(route, { forum_topic_created: { name: "hola como", is_name_implicit: true } });
    assert.equal((await store.getTopic(42, 42, 7)).nameImplicit, true);

    const calls = [];
    const { createSessionBridge } = createTelegramSessionBridgeController({
      config,
      api: { editForumTopic: async (...args) => calls.push(args) },
      workspaceTopics: store
    });
    const result = await createSessionBridge(route).renameForumTopic({ name: "Trip to Madrid" });
    assert.deepEqual(calls, [[42, 7, { name: "Trip to Madrid" }]]);
    assert.equal(result.messageThreadId, 7);
    const topic = await store.getTopic(42, 42, 7);
    assert.equal(topic.name, "Trip to Madrid");
    assert.equal(topic.nameImplicit, undefined);
  } finally {
    await cleanup();
  }
});

test("renaming from General requires an explicit topic and tasks keep their topic destination", async () => {
  const { createSessionBridge } = createTelegramSessionBridgeController({ config, api: {}, workspaceTopics: {} });
  const general = { workspace: true, privateTopics: true, ownerChatId: 42, transportChatId: 42, threadId: null, topicThreadId: null, generalTopicId: null };
  await assert.rejects(createSessionBridge(general).renameForumTopic({ name: "x" }), /messageThreadId/);
  assert.equal(createSessionBridge(general).getTaskContext(), null);
  assert.deepEqual(createSessionBridge({ ...general, threadId: 7, topicThreadId: 7 }).getTaskContext(), {
    transport: "telegram",
    destination: { chatId: 42, threadId: 7 }
  });
});

test("draft previews hide routing markers and possible silent replies", () => {
  assert.equal(draftPreview("Working on it\n[[ARISA_REPLY_TOP"), "Working on it");
  assert.equal(draftPreview("NO_REP"), "");
  assert.equal(draftPreview("x".repeat(4000)).length, 3501);
});

test("a draft stream sends changes inside the topic and closes after an API failure", async () => {
  const sent = [];
  let fail = false;
  const errors = [];
  const stream = createReplyDraftStream({
    api: {
      sendMessageDraft: async (...args) => {
        if (fail) throw new Error("drafts unavailable");
        sent.push(args);
      }
    },
    chatId: 42,
    threadId: 7,
    intervalMs: 60_000,
    keepAliveMs: 60_000,
    logger: { error: (_scope, message) => errors.push(message) }
  });
  try {
    await stream.started;
    stream.update("**Hello**");
    await stream.flush();
    await stream.flush();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].slice(0, 3), [42, stream.draftId, ""]);
    assert.deepEqual(sent[0][3], { message_thread_id: 7, can_stop: true });
    assert.deepEqual(sent[1].slice(2), ["<b>Hello</b>", { message_thread_id: 7, parse_mode: "HTML", can_stop: true }]);

    fail = true;
    stream.update("Hello again");
    await stream.flush();
    fail = false;
    stream.update("Hello once more");
    await stream.flush();
    assert.equal(sent.length, 2);
    assert.equal(errors.length, 1);
  } finally {
    stream.close();
  }
});

test("stopping a draft aborts the turn and delivers the partial reply without resetting the session", async () => {
  const stateStore = createChatStateStore();
  const events = { drafts: [], aborted: [], reset: [], replies: [] };
  let listener = null;
  let stopTurn = null;
  const session = {
    subscribe: (handler) => {
      listener = handler;
      return () => {};
    },
    prompt: () => new Promise((_resolve, reject) => {
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial answer" } });
      stopTurn = () => reject(new Error("aborted"));
    })
  };
  const controller = createTelegramPromptController({
    config: {
      pi: { speed: 1, chatModels: {}, subagents: { isolateAutomations: true } },
      telegram: { streamReplies: true, replyDraftIntervalMs: 60_000, replyDraftKeepAliveMs: 60_000 }
    },
    api: { sendMessageDraft: async (_chatId, draftId) => events.drafts.push(draftId) },
    agentManager: {
      resetSession: (...args) => events.reset.push(args),
      runTurn: async (_options, work) => work(),
      abortSession: async (sessionId) => {
        events.aborted.push(sessionId);
        stopTurn();
      },
      getSessionContext: async () => ({ session, speedController: { setSpeed() {} }, release: async () => {} })
    },
    sessionSeeds: { consume: async () => "" },
    workspaceTopics: { listTopics: async () => [] },
    contextRoute: (ctx) => ctx.route,
    getChatState: (chatId) => stateStore.get(chatId),
    createTelegramSessionBridge: () => ({}),
    createWorkspaceAccessGuard: () => async () => {},
    sendTextReply: async ({ text }) => events.replies.push(text),
    authController: { notifyIssueIfNeeded: async () => false },
    ensureWorkspaceTopicModelSelection: async () => {},
    ensureQueuedTyping: async () => {},
    withTyping: async (_ctx, work) => work(),
    resolveBusyMessageMode: () => "steer"
  });
  const route = { workspace: true, privateTopics: true, ownerChatId: 42, sessionId: "42--telegram-private-topic-7", scopeChatId: 42, transportChatId: 42, threadId: 7, topicThreadId: 7, generalTopicId: null };

  const turn = controller.processPromptForChat({ chatId: route.sessionId, prompt: "hello", ctx: { route } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.drafts.length, 1);
  assert.equal(await controller.stopReplyDraft({ chatId: 99, draftId: events.drafts[0] }), false);
  assert.equal(await controller.stopReplyDraft({ chatId: 42, draftId: events.drafts[0] }), true);
  await turn;

  assert.deepEqual(events.aborted, [route.sessionId]);
  assert.deepEqual(events.reset, []);
  assert.deepEqual(events.replies, ["Partial answer"]);
});
