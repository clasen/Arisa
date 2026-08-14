import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUpdatePicker,
  createTelegramUpdateCallbackHandler,
  parseUpdateAction
} from "../src/transport/telegram/update-command.js";

function report(overrides = {}) {
  return {
    core: { currentVersion: "5.0.2", latestVersion: "5.1.0", updateAvailable: true },
    bootstrapInstalled: [],
    tools: {
      installedOfficial: 2,
      official: [],
      nonOfficial: [],
      counts: {},
      updateable: ["context-vault", "gmail-workspace"],
      blocked: []
    },
    ...overrides
  };
}

test("offers only available update actions", () => {
  assert.deepEqual(buildUpdatePicker(report()).replyMarkup.inline_keyboard, [
    [{ text: "Update Arisa → 5.1.0", callback_data: "arisa-update:core:5.1.0" }],
    [{ text: "Update safe tools (2)", callback_data: "arisa-update:tools" }],
    [{ text: "Not now", callback_data: "arisa-update:close" }]
  ]);

  assert.deepEqual(buildUpdatePicker(report({
    core: { currentVersion: "5.1.0", latestVersion: "5.1.0", updateAvailable: false },
    tools: { ...report().tools, updateable: [] }
  })).replyMarkup.inline_keyboard, [
    [{ text: "Up to date", callback_data: "arisa-update:noop" }]
  ]);
});

test("parses only valid update callback data", () => {
  assert.deepEqual(parseUpdateAction("arisa-update:core:5.1.0"), { type: "core", targetVersion: "5.1.0" });
  assert.deepEqual(parseUpdateAction("arisa-update:tools"), { type: "tools" });
  assert.deepEqual(parseUpdateAction("arisa-update:close"), { type: "close" });
  assert.deepEqual(parseUpdateAction("arisa-update:noop"), { type: "noop" });
  assert.equal(parseUpdateAction("arisa-update:core:latest"), null);
  assert.equal(parseUpdateAction("model:1"), null);
});

test("applies a confirmed core update and then requests restart", async () => {
  const calls = [];
  const handler = createTelegramUpdateCallbackHandler({
    authorize: async () => ({ ok: true }),
    updateCore: async (targetVersion) => {
      calls.push(["updateCore", targetVersion]);
      return { updated: true, previousVersion: "5.0.2", currentVersion: targetVersion };
    },
    updateTools: async () => assert.fail("must not update tools"),
    requestRestart: async () => { calls.push("restart"); }
  });
  const ctx = {
    chat: { id: 42 },
    callbackQuery: { data: "arisa-update:core:5.1.0", message: { message_id: 7 } },
    answerCallbackQuery: async (payload) => { calls.push(["answer", payload]); },
    api: {
      editMessageText: async (...args) => { calls.push(["edit", ...args]); }
    }
  };

  assert.equal(await handler(ctx), true);
  assert.deepEqual(calls, [
    ["answer", { text: "Updating Arisa…" }],
    ["edit", 42, 7, "Updating Arisa to 5.1.0…"],
    ["updateCore", "5.1.0"],
    ["edit", 42, 7, "Arisa updated from 5.0.2 to 5.1.0. Restarting…"],
    "restart"
  ]);
});

test("uses official-tool-sync for the confirmed safe tool action", async () => {
  const calls = [];
  const handler = createTelegramUpdateCallbackHandler({
    authorize: async () => ({ ok: true }),
    updateCore: async () => assert.fail("must not update core"),
    updateTools: async (chatId) => {
      calls.push(["updateTools", chatId]);
      return {
        updated: ["context-vault"],
        skipped: [{ name: "customized", status: "locally-modified" }]
      };
    },
    requestRestart: async () => assert.fail("tool updates do not restart Arisa")
  });
  const ctx = {
    chat: { id: 42 },
    callbackQuery: { data: "arisa-update:tools", message: { message_id: 7 } },
    answerCallbackQuery: async (payload) => { calls.push(["answer", payload]); },
    api: {
      editMessageText: async (...args) => { calls.push(["edit", ...args]); }
    }
  };

  assert.equal(await handler(ctx), true);
  assert.deepEqual(calls, [
    ["answer", { text: "Updating safe tools…" }],
    ["edit", 42, 7, "Updating safe official tools…"],
    ["updateTools", 42],
    ["edit", 42, 7, [
      "Updated official tools:",
      "- context-vault",
      "",
      "Not changed (needs review):",
      "- customized [locally-modified]"
    ].join("\n")]
  ]);
});

test("reports restart failure separately after a successful core update", async () => {
  const edits = [];
  const handler = createTelegramUpdateCallbackHandler({
    authorize: async () => ({ ok: true }),
    updateCore: async () => ({ updated: true, previousVersion: "5.0.2", currentVersion: "5.1.0" }),
    updateTools: async () => assert.fail("must not update tools"),
    requestRestart: async () => { throw new Error("not running as a service"); }
  });
  const ctx = {
    chat: { id: 42 },
    callbackQuery: { data: "arisa-update:core:5.1.0", message: { message_id: 7 } },
    answerCallbackQuery: async () => {},
    api: {
      editMessageText: async (_chatId, _messageId, text) => { edits.push(text); }
    }
  };

  assert.equal(await handler(ctx), true);
  assert.equal(edits.at(-1), [
    "Arisa updated to 5.1.0, but restart failed: not running as a service",
    "Run /restart to activate it."
  ].join("\n"));
});
