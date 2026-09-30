import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramToolsCommandHandler } from "../src/transport/telegram/telegram-tools-command.js";

test("/tools shows typing and sends the scoped usage report", async () => {
  const events = [];
  const handler = createTelegramToolsCommandHandler({
    authorize: async () => ({ ok: true }),
    contextRoute: () => ({ scopeChatId: 879964957 }),
    toolRegistry: {
      usage: async (chatId) => {
        assert.equal(chatId, 879964957);
        return [{ name: "example", count: 2, official: true }];
      }
    },
    withTyping: async (_ctx, work) => {
      events.push("typing");
      return work();
    },
    logger: null
  });
  const ctx = {
    chat: { id: 879964957 },
    reply: async (text, options) => events.push({ text, options })
  };

  await handler(ctx);

  assert.equal(events[0], "typing");
  assert.match(events[1].text, /example/);
  assert.deepEqual(events[1].options, { parse_mode: "HTML" });
});

test("/tools sends long names and large counts without a report width error", async () => {
  const replies = [];
  const handler = createTelegramToolsCommandHandler({
    authorize: async () => ({ ok: true }),
    contextRoute: () => ({ scopeChatId: 1 }),
    toolRegistry: { usage: async () => [
      { name: "gmail-workspace", count: 6970, official: true },
      { name: "a".repeat(28), count: 12, official: false }
    ] },
    withTyping: async (_ctx, work) => work(),
    logger: null
  });
  await handler({ chat: { id: 1 }, reply: async (text, options) => replies.push({ text, options }) });
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /gmail-workspace\s+6970/);
  assert.doesNotMatch(replies[0].text, /Tool usage report failed/);
  assert.deepEqual(replies[0].options, { parse_mode: "HTML" });
});

test("/tools reports failures instead of disappearing", async () => {
  const replies = [];
  const handler = createTelegramToolsCommandHandler({
    authorize: async () => ({ ok: true }),
    contextRoute: () => ({ scopeChatId: 1 }),
    toolRegistry: { usage: async () => { throw new Error("store unavailable"); } },
    withTyping: async (_ctx, work) => work(),
    logger: null
  });

  await handler({ chat: { id: 1 }, reply: async (text) => replies.push(text) });

  assert.deepEqual(replies, ["Tool usage report failed: store unavailable"]);
});
