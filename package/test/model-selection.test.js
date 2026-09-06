import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  resolveChatModel,
  resolveChatModelSelection,
  resolveChatSpeed,
  resolveChatThinkingLevel,
  selectChatModel,
  selectChatSpeed,
  selectChatThinkingLevel
} from "../src/core/agent/model-selection.js";
import {
  applyConfigDefaults,
  piConfigDefaults,
  telegramConfigDefaults,
  toolExecutionConfigDefaults
} from "../src/core/config/config-defaults.js";
import {
  clampModelThinkingLevel,
  listModelThinkingLevels,
  modelSupportsThinking
} from "../src/core/agent/pi-runtime.js";
import { clampModelSpeed, createModelSpeedController, modelSupportsSpeed, normalizeModelSpeed, speedToServiceTier } from "../src/core/agent/model-speed.js";
import { getChatPiSessionsDir } from "../src/runtime/paths.js";
import {
  buildEffortPicker,
  buildModelPicker,
  buildSpeedPicker,
  parseEffortPickerAction,
  parseModelPickerAction,
  parseSpeedPickerAction,
  reverseModelOrder
} from "../src/transport/telegram/model-picker.js";
import { closeModelPicker, createTelegramModelCallbackHandler } from "../src/transport/telegram/model-callback.js";

function createConfig() {
  return applyConfigDefaults({
    telegram: {},
    pi: {
      provider: "openai-codex",
      model: "gpt-default"
    }
  });
}

test("resolves the default model until a chat selects one", () => {
  const config = createConfig();

  assert.equal(resolveChatModel(config, 123), "gpt-default");
  assert.equal(resolveChatThinkingLevel(config, 123), piConfigDefaults.thinkingLevel);

  selectChatModel(config, 123, { provider: "openai-codex", id: "gpt-selected" }, { thinkingLevel: "high" });

  assert.equal(resolveChatModel(config, 123), "gpt-selected");
  assert.equal(resolveChatThinkingLevel(config, 123), "high");
  assert.equal(resolveChatModel(config, 456), "gpt-default");
  assert.deepEqual(config.pi.chatModels["123"], {
    provider: "openai-codex",
    model: "gpt-selected",
    thinkingLevel: "high",
    speed: 1,
    sessionRevision: 1
  });
});

test("starts a distinct persisted Pi session revision on every model change", () => {
  const config = createConfig();

  selectChatModel(config, 123, { provider: "openai-codex", id: "gpt-a" }, { thinkingLevel: "medium" });
  selectChatModel(config, 123, { provider: "openai-codex", id: "gpt-b" }, { thinkingLevel: "high" });

  assert.equal(config.pi.chatModels["123"].sessionRevision, 2);
  assert.equal(
    getChatPiSessionsDir(123, config.pi.chatModels["123"].sessionRevision),
    path.join(getChatPiSessionsDir(123), "2")
  );
});

test("updates effort without bumping the session revision", () => {
  const config = createConfig();

  selectChatModel(config, 123, { provider: "openai-codex", id: "gpt-a" }, { thinkingLevel: "medium" });
  selectChatThinkingLevel(config, 123, "high");

  assert.deepEqual(resolveChatModelSelection(config, 123), {
    provider: "openai-codex",
    model: "gpt-a",
    thinkingLevel: "high",
    speed: 1,
    sessionRevision: 1
  });
});

test("updates Pi speed without bumping the session revision", () => {
  const config = createConfig();

  selectChatModel(config, 123, { provider: "openai-codex", id: "gpt-5.6-sol" }, { thinkingLevel: "high" });
  selectChatSpeed(config, 123, 1.5);

  assert.equal(resolveChatSpeed(config, 123), 1.5);
  assert.equal(config.pi.chatModels["123"].sessionRevision, 1);
  assert.equal(config.pi.chatModels["123"].thinkingLevel, "high");
});

test("ignores a chat selection from a different active provider", () => {
  const config = createConfig();
  config.pi.chatModels = {
    123: { provider: "anthropic", model: "claude-selected", thinkingLevel: "high", sessionRevision: 1 }
  };

  assert.equal(resolveChatModel(config, 123), "gpt-default");
  assert.equal(resolveChatThinkingLevel(config, 123), piConfigDefaults.thinkingLevel);
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
    selectedThinkingLevel: "high",
    page: 0,
    pageSize: 2
  });

  assert.match(picker.text, /openai-codex\/gpt-b/);
  assert.match(picker.text, /Effort: high/);
  assert.equal(picker.replyMarkup.inline_keyboard[0][0].callback_data, "model:0");
  assert.match(picker.replyMarkup.inline_keyboard[1][0].text, /^✓ gpt-b \[reasoning, image\]$/);
  assert.equal(picker.replyMarkup.inline_keyboard[2][1].callback_data, "model-page:1");
});

test("reverses model order without mutating the provider list", () => {
  const models = [
    { provider: "openai-codex", id: "gpt-old" },
    { provider: "openai-codex", id: "gpt-current" },
    { provider: "openai-codex", id: "gpt-new" }
  ];

  assert.deepEqual(reverseModelOrder(models).map((model) => model.id), [
    "gpt-new",
    "gpt-current",
    "gpt-old"
  ]);
  assert.deepEqual(models.map((model) => model.id), [
    "gpt-old",
    "gpt-current",
    "gpt-new"
  ]);
});

test("builds an effort picker for the current model or pending model choice", () => {
  const current = buildEffortPicker({
    provider: "openai-codex",
    modelId: "gpt-b",
    levels: ["off", "low", "medium", "high"],
    selectedThinkingLevel: "medium"
  });
  assert.match(current.text, /Current model: openai-codex\/gpt-b/);
  assert.equal(current.replyMarkup.inline_keyboard[1][0].callback_data, "effort:low");
  assert.match(current.replyMarkup.inline_keyboard[2][0].text, /^✓ medium$/);

  const pending = buildEffortPicker({
    provider: "openai-codex",
    modelId: "gpt-b",
    levels: ["off", "high"],
    selectedThinkingLevel: "high",
    modelIndex: 4
  });
  assert.match(pending.text, /^Model: openai-codex\/gpt-b/);
  assert.equal(pending.replyMarkup.inline_keyboard[1][0].callback_data, "model-effort:4:high");
});

test("builds and parses the speed picker", () => {
  const picker = buildSpeedPicker({
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
    speeds: [1, 1.5],
    selectedSpeed: 1.5
  });
  assert.equal(picker.replyMarkup.inline_keyboard[0][0].callback_data, "speed:1");
  assert.match(picker.replyMarkup.inline_keyboard[1][0].text, /^✓ 1\.5x$/);
  assert.deepEqual(parseSpeedPickerAction("speed:1.5"), { type: "speed", speed: 1.5 });
  assert.deepEqual(parseSpeedPickerAction("speed:1"), { type: "speed", speed: 1 });
  assert.equal(parseSpeedPickerAction("speed:3"), null);
});

test("closes the picker after selecting the already active model and effort", async () => {
  const calls = [];
  const ctx = {
    chat: { id: 123 },
    callbackQuery: { message: { message_id: 456 } },
    api: {
      async editMessageText(...args) {
        calls.push(["editMessageText", ...args]);
      }
    },
    async answerCallbackQuery(...args) {
      calls.push(["answerCallbackQuery", ...args]);
    }
  };

  await closeModelPicker(ctx, {
    messageText: "Already using openai-codex/gpt-b (effort: high).",
    callbackText: "Already using gpt-b at high."
  });

  assert.deepEqual(calls, [
    ["editMessageText", 123, 456, "Already using openai-codex/gpt-b (effort: high)."],
    ["answerCallbackQuery", { text: "Already using gpt-b at high." }]
  ]);
});

test("model callback handler delegates unrelated callbacks", async () => {
  let delegated = false;
  const handler = createTelegramModelCallbackHandler({
    config: createConfig(),
    authorizeContext: async () => { throw new Error("must not authorize"); },
    contextRoute: () => ({ sessionId: "123" }),
    getChatState: () => ({ processing: false }),
    logger: null
  });

  await handler({ callbackQuery: { data: "other:action" } }, async () => { delegated = true; });
  assert.equal(delegated, true);
});

test("model callback handler persists a non-reasoning model selection", async () => {
  const config = createConfig();
  const calls = [];
  const handler = createTelegramModelCallbackHandler({
    config,
    authorizeContext: async () => ({ ok: true }),
    contextRoute: () => ({ sessionId: "123" }),
    getChatState: () => ({ processing: false }),
    getProviderModels: async () => [{ provider: "openai-codex", id: "gpt-next", reasoning: false }],
    showModelPicker: async () => {},
    showEffortPicker: async () => {},
    persistChatModel: async (...args) => calls.push(["persist", ...args]),
    persistChatEffort: async () => {},
    persistChatSpeed: async () => {},
    logger: null
  });
  const ctx = {
    chat: { id: 123 },
    callbackQuery: { data: "model:0", message: { message_id: 456 } },
    api: { async editMessageText(...args) { calls.push(["edit", ...args]); } },
    async answerCallbackQuery(...args) { calls.push(["answer", ...args]); }
  };

  await handler(ctx, async () => {});

  assert.deepEqual(calls, [
    ["persist", "123", { provider: "openai-codex", id: "gpt-next", reasoning: false }, "off"],
    ["edit", 123, 456, "Model changed to openai-codex/gpt-next.\nA new chat context will start with your next message."],
    ["answer", { text: "Using gpt-next." }]
  ]);
});

test("parses only model picker callback data", () => {
  assert.deepEqual(parseModelPickerAction("model:12"), { type: "select", value: 12 });
  assert.deepEqual(parseModelPickerAction("model-page:2"), { type: "page", value: 2 });
  assert.deepEqual(parseModelPickerAction("noop:page"), { type: "noop", value: null });
  assert.equal(parseModelPickerAction("provider:1"), null);
  assert.equal(parseModelPickerAction("model:-1"), null);
  assert.equal(parseModelPickerAction("effort:high"), null);
});

test("parses effort picker callback data", () => {
  assert.deepEqual(parseEffortPickerAction("effort:high"), { type: "effort", level: "high" });
  assert.deepEqual(parseEffortPickerAction("model-effort:3:medium"), {
    type: "model-effort",
    modelIndex: 3,
    level: "medium"
  });
  assert.deepEqual(parseEffortPickerAction("noop:page"), { type: "noop", value: null });
  assert.equal(parseEffortPickerAction("model:1"), null);
});

test("centralizes Telegram and Pi defaults in config", () => {
  const config = applyConfigDefaults({
    telegram: {},
    pi: { provider: "openai-codex", model: "gpt-default" }
  });

  assert.equal(config.telegram.modelPickerPageSize, telegramConfigDefaults.modelPickerPageSize);
  assert.equal(config.telegram.busyMessageMode, "steer");
  assert.equal(config.toolExecution.defaultCapacity, toolExecutionConfigDefaults.defaultCapacity);
  assert.equal(config.toolExecution.maxQueuedPerClass, 100);
  assert.equal(config.toolExecution.maxWorkerRssMb, 384);
  assert.equal(config.toolExecution.maxSwapUsedPercent, 95);
  assert.equal(config.toolExecution.initialToolMemoryMb, 384);
  assert.equal(config.toolExecution.minimumToolMemoryMb, 128);
  assert.equal(config.toolExecution.maximumToolMemoryMb, 4096);
  assert.equal(config.toolExecution.systemReserveMb, 128);
  assert.equal(config.toolExecution.coreReserveMb, 384);
  assert.equal(config.toolExecution.toolHeapPercent, 65);
  assert.equal(config.toolExecution.toolMemoryHighPercent, 85);
  assert.equal(config.toolExecution.toolSwapMaxMb, 128);
  assert.deepEqual(config.toolExecution.capacities, { browser: 1, orchestrator: 1 });
  assert.equal(config.pi.thinkingLevel, piConfigDefaults.thinkingLevel);
  assert.equal(config.pi.speed, piConfigDefaults.speed);
});

test("lists and clamps thinking levels from model capabilities", () => {
  const reasoning = {
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", minimal: "low", max: null }
  };
  assert.deepEqual(listModelThinkingLevels(reasoning), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh"
  ]);
  assert.equal(clampModelThinkingLevel(reasoning, "max"), "xhigh");
  assert.equal(modelSupportsThinking(reasoning), true);

  const plain = { reasoning: false };
  assert.deepEqual(listModelThinkingLevels(plain), ["off"]);
  assert.equal(clampModelThinkingLevel(plain, "high"), "off");
  assert.equal(modelSupportsThinking(plain), false);
});

test("maps supported model speeds to provider service tiers", () => {
  const fastModel = {
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-5.6-sol"
  };
  assert.equal(modelSupportsSpeed(fastModel), true);
  assert.equal(clampModelSpeed(fastModel, 1.5), 1.5);
  assert.equal(clampModelSpeed({ ...fastModel, id: "gpt-5.3" }, 1.5), 1);
  assert.equal(speedToServiceTier(1), "default");
  assert.equal(speedToServiceTier(1.5), "priority");
  assert.equal(normalizeModelSpeed(2), 2);
  assert.equal(speedToServiceTier(2), "priority");
  const legacyConfig = { pi: { provider: "openai-codex", model: "gpt-6-astra", speed: 1.5 } };
  assert.equal(resolveChatSpeed(legacyConfig, "legacy"), 2);
  assert.equal(legacyConfig.pi.speed, 1.5);
  assert.equal(clampModelSpeed({ ...fastModel, id: "gpt-6-astra" }, 1.5), 2);
  assert.equal(clampModelSpeed({ ...fastModel, id: "gpt-6-astra" }, 2), 2);
  assert.equal(clampModelSpeed(fastModel, 2), 1.5);
  assert.deepEqual(parseSpeedPickerAction("speed:2"), { type: "speed", speed: 2 });
  assert.throws(() => normalizeModelSpeed(3), /Invalid model speed/);
});

test("applies Pi speed to every provider request and updates it in place", async () => {
  const calls = [];
  const model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" };
  const controller = createModelSpeedController((model, context, options) => {
    calls.push({ model, context, options });
    return "stream";
  }, 1);

  assert.equal(controller.streamFn(model, "context", {
    signal: "signal",
    onPayload: (payload) => ({ ...payload, preserved: true })
  }), "stream");
  controller.setSpeed(1.5);
  controller.streamFn(model, "context", { signal: "signal" });

  assert.equal(calls[0].options.serviceTier, "default");
  assert.equal(calls[1].options.serviceTier, "priority");
  assert.equal(calls[1].options.signal, "signal");
  assert.deepEqual(await calls[0].options.onPayload({ model: "gpt" }, "model"), {
    model: "gpt",
    preserved: true,
    service_tier: "default"
  });
  assert.deepEqual(await calls[1].options.onPayload({ model: "gpt" }, "model"), {
    model: "gpt",
    service_tier: "priority"
  });
});
