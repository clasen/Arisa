import assert from "node:assert/strict";
import test from "node:test";
import { authorizeChat } from "../src/transport/telegram/auth.js";

function createConfig(overrides = {}) {
  return {
    telegram: {
      authorizedChatIds: [],
      maxChatIds: 2,
      chatMeta: {},
      ...(overrides.telegram || {})
    }
  };
}

function createSaveConfigSpy() {
  const calls = [];
  const saveConfig = async (config) => {
    calls.push(JSON.parse(JSON.stringify(config)));
  };
  return { saveConfig, calls };
}

test("authorizes a new chat below the configured limit", async () => {
  const config = createConfig();
  const { saveConfig, calls } = createSaveConfigSpy();

  const result = await authorizeChat({ config, chatId: 123, saveConfig });

  assert.deepEqual(result, { ok: true, firstTime: true });
  assert.deepEqual(config.telegram.authorizedChatIds, [123]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].telegram.authorizedChatIds, [123]);
});

test("keeps an authorized chat id unique", async () => {
  const config = createConfig({
    telegram: { authorizedChatIds: [123] }
  });
  const { saveConfig, calls } = createSaveConfigSpy();

  const result = await authorizeChat({ config, chatId: 123, saveConfig });

  assert.deepEqual(result, { ok: true, firstTime: false });
  assert.deepEqual(config.telegram.authorizedChatIds, [123]);
  assert.equal(calls.length, 0);
});

test("rejects a new chat when the chat id limit is reached", async () => {
  const config = createConfig({
    telegram: { authorizedChatIds: [123, 456], maxChatIds: 2 }
  });
  const { saveConfig, calls } = createSaveConfigSpy();

  const result = await authorizeChat({ config, chatId: 789, saveConfig });

  assert.deepEqual(result, { ok: false, reason: "max-chat-ids" });
  assert.deepEqual(config.telegram.authorizedChatIds, [123, 456]);
  assert.equal(calls.length, 0);
});

test("enforces the maxChatIds off-by-one boundary", async () => {
  const config = createConfig({
    telegram: { authorizedChatIds: [123], maxChatIds: 1 }
  });
  const { saveConfig, calls } = createSaveConfigSpy();

  const result = await authorizeChat({ config, chatId: 456, saveConfig });

  assert.deepEqual(result, { ok: false, reason: "max-chat-ids" });
  assert.deepEqual(config.telegram.authorizedChatIds, [123]);
  assert.equal(calls.length, 0);
});

test("merges chat metadata for an existing authorized chat and persists it", async () => {
  const config = createConfig({
    telegram: {
      authorizedChatIds: [123],
      chatMeta: {
        123: { username: "old-name", firstName: "Ada" }
      }
    }
  });
  const { saveConfig, calls } = createSaveConfigSpy();

  const result = await authorizeChat({
    config,
    chatId: 123,
    saveConfig,
    chatMeta: { username: "new-name", lastName: "Lovelace" }
  });

  assert.deepEqual(result, { ok: true, firstTime: false });
  assert.deepEqual(config.telegram.chatMeta[123], {
    username: "new-name",
    firstName: "Ada",
    lastName: "Lovelace"
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].telegram.chatMeta[123], config.telegram.chatMeta[123]);
});
