import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveChatModel, selectChatModel } from "../src/core/agent/model-selection.js";
import { applyConfigDefaults, telegramConfigDefaults } from "../src/core/config/config-defaults.js";
import { getChatPiSessionsDir } from "../src/runtime/paths.js";
import { buildModelPicker, parseModelPickerAction } from "../src/transport/telegram/model-picker.js";

function createConfig() {
  return {
    telegram: {},
    pi: {
      provider: "openai-codex",
      model: "gpt-default"
    }
  };
}

test("resolves the default model until a chat selects one", () => {
  const config = createConfig();

  assert.equal(resolveChatModel(config, 123), "gpt-default");

  selectChatModel(config, 123, { provider: "openai-codex", id: "gpt-selected" });

  assert.equal(resolveChatModel(config, 123), "gpt-selected");
  assert.equal(resolveChatModel(config, 456), "gpt-default");
  assert.deepEqual(config.pi.chatModels["123"], {
    provider: "openai-codex",
    model: "gpt-selected",
    sessionRevision: 1
  });
});

test("starts a distinct persisted Pi session revision on every model change", () => {
  const config = createConfig();

  selectChatModel(config, 123, { provider: "openai-codex", id: "gpt-a" });
  selectChatModel(config, 123, { provider: "openai-codex", id: "gpt-b" });

  assert.equal(config.pi.chatModels["123"].sessionRevision, 2);
  assert.equal(
    getChatPiSessionsDir(123, config.pi.chatModels["123"].sessionRevision),
    path.join(getChatPiSessionsDir(123), "2")
  );
});

test("ignores a chat selection from a different active provider", () => {
  const config = createConfig();
  config.pi.chatModels = {
    123: { provider: "anthropic", model: "claude-selected" }
  };

  assert.equal(resolveChatModel(config, 123), "gpt-default");
});

test("rejects selecting a model outside the active provider", () => {
  const config = createConfig();

  assert.throws(
    () => selectChatModel(config, 123, { provider: "anthropic", id: "claude-selected" }),
    /active provider is openai-codex/
  );
});

test("builds a paged model picker and marks the current model", () => {
  const models = [
    { provider: "openai-codex", id: "gpt-a", reasoning: false, input: ["text"] },
    { provider: "openai-codex", id: "gpt-b", reasoning: true, input: ["text", "image"] },
    { provider: "openai-codex", id: "gpt-c", reasoning: false, input: ["text"] }
  ];

  const picker = buildModelPicker({
    provider: "openai-codex",
    models,
    selectedModelId: "gpt-b",
    page: 0,
    pageSize: 2
  });

  assert.match(picker.text, /openai-codex\/gpt-b/);
  assert.equal(picker.replyMarkup.inline_keyboard[0][0].callback_data, "model:0");
  assert.match(picker.replyMarkup.inline_keyboard[1][0].text, /^✓ gpt-b \[reasoning, image\]$/);
  assert.equal(picker.replyMarkup.inline_keyboard[2][1].callback_data, "model-page:1");
});

test("parses only model picker callback data", () => {
  assert.deepEqual(parseModelPickerAction("model:12"), { type: "select", value: 12 });
  assert.deepEqual(parseModelPickerAction("model-page:2"), { type: "page", value: 2 });
  assert.deepEqual(parseModelPickerAction("noop:page"), { type: "noop", value: null });
  assert.equal(parseModelPickerAction("provider:1"), null);
  assert.equal(parseModelPickerAction("model:-1"), null);
});

test("centralizes the model picker page size in Telegram config defaults", () => {
  const config = applyConfigDefaults(createConfig());

  assert.equal(config.telegram.modelPickerPageSize, telegramConfigDefaults.modelPickerPageSize);
});
