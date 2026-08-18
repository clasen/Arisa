import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveTelegramWorkspaceRoute,
  topicSessionId,
  verifyOwnerWorkspaceGroup
} from "../src/transport/telegram/workspace-group.js";

function api({ count = 2, ownerId = 42, botAdmin = true } = {}) {
  return {
    getChatMemberCount: async () => count,
    getChatAdministrators: async () => [
      { status: "creator", user: { id: ownerId } },
      ...(botAdmin ? [{ status: "administrator", user: { id: 99 } }] : [])
    ],
    getMe: async () => ({ id: 99 })
  };
}

test("general topic reuses the owner session while other topics stay separate", () => {
  assert.equal(topicSessionId({ ownerChatId: 42, groupChatId: -100123, threadId: 1 }), "42");
  assert.equal(
    topicSessionId({ ownerChatId: 42, groupChatId: -100123, threadId: 7 }),
    "42--telegram-group-100123--topic-7"
  );
});

test("general topic omits Telegram's non-addressable thread id for replies", async () => {
  const route = await resolveTelegramWorkspaceRoute({
    config: { telegram: { ownerWorkspaceGroups: { "-100123": { ownerChatId: 42, generalTopicId: 1 } } } },
    api: api(),
    ctx: {
      chat: { id: -100123, type: "supergroup", is_forum: true },
      from: { id: 42 },
      message: { message_thread_id: 1 }
    }
  });
  assert.equal(route.sessionId, "42");
  assert.equal(route.topicThreadId, 1);
  assert.equal(route.threadId, null);
});

test("owner workspace gate accepts bot service events but still blocks a third member", async () => {
  assert.deepEqual(
    await verifyOwnerWorkspaceGroup({ api: api(), groupChatId: -100123, ownerChatId: 42, senderId: 99 }),
    { ok: true, memberCount: 2 }
  );
  assert.deepEqual(
    await verifyOwnerWorkspaceGroup({ api: api({ count: 3 }), groupChatId: -100123, ownerChatId: 42, senderId: 99 }),
    { ok: false, reason: "member-count", memberCount: 3 }
  );
});

test("workspace route shares owner scope and isolates topic session", async () => {
  const config = {
    telegram: {
      ownerWorkspaceGroups: {
        "-100123": { ownerChatId: 42, generalTopicId: 1 }
      }
    }
  };
  const route = await resolveTelegramWorkspaceRoute({
    config,
    api: api(),
    ctx: {
      chat: { id: -100123, type: "supergroup", is_forum: true },
      from: { id: 42 },
      message: { message_thread_id: 8 }
    }
  });
  assert.equal(route.ok, true);
  assert.equal(route.scopeChatId, 42);
  assert.equal(route.transportChatId, -100123);
  assert.equal(route.threadId, 8);
  assert.equal(route.sessionId, "42--telegram-group-100123--topic-8");
});
