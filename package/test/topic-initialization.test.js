import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTopicInitializationHandoff, isProcessableTelegramMessage, startTelegramTyping } from "../src/transport/telegram/bot.js";
import { SessionSeedStore } from "../src/core/conversation/session-seed-store.js";

test("Telegram typing action stays inside the message topic", async () => {
  const calls = [];
  const stop = await startTelegramTyping({
    chat: { id: "chat-1" },
    message: { message_thread_id: 42 },
    api: {
      sendChatAction: async (chatId, action, options) => {
        calls.push({ chatId, action, options });
      }
    }
  });
  stop();

  assert.deepEqual(calls, [
    { chatId: "chat-1", action: "typing", options: { message_thread_id: 42 } }
  ]);
});

test("Telegram service messages do not become empty agent prompts", () => {
  assert.equal(isProcessableTelegramMessage({ forum_topic_created: { name: "Stories" } }), false);
  assert.equal(isProcessableTelegramMessage({ forum_topic_edited: { name: "Stories" } }), false);
  assert.equal(isProcessableTelegramMessage({ text: "hello" }), true);
  assert.equal(isProcessableTelegramMessage({ voice: { file_id: "voice" } }), true);
});

test("topic initialization context is explicit and bounded to the topic", () => {
  const handoff = buildTopicInitializationHandoff({ name: "Stories", context: "Draft first-person development stories for arisa.sh." });
  assert.match(handoff, /Telegram topic: Stories/);
  assert.match(handoff, /isolated conversation session/);
  assert.match(handoff, /Draft first-person development stories/);
});

test("a persisted session seed is consumed exactly once and can be replaced", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arisa-topic-seed-"));
  const seedFile = (chatId) => path.join(directory, `${chatId}.jsonl`);
  const legacyFile = (chatId) => path.join(directory, `${chatId}.legacy.jsonl`);
  const store = new SessionSeedStore({ seedFile, legacyFile });
  try {
    await store.set("topic", "Stories context");
    assert.equal(await store.consume("topic"), "Stories context");
    assert.equal(await store.consume("topic"), "");

    await store.set("topic", "Replacement context");
    assert.equal(await store.consume("topic"), "Replacement context");

    await writeFile(legacyFile("pending-legacy"), `${JSON.stringify({ kind: "seed", history: "Pending legacy context" })}\n`, "utf8");
    assert.equal(await store.consume("pending-legacy"), "Pending legacy context");

    await writeFile(legacyFile("legacy"), [
      JSON.stringify({ kind: "seed", history: "Old portable context" }),
      JSON.stringify({ kind: "turn", prompt: "stale", response: "stale" }),
      ""
    ].join("\n"), "utf8");
    assert.equal(await store.consume("legacy"), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
