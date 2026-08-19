import {
  getAgentConfig,
  resolveChatModel,
  resolveChatSpeed,
  resolveChatThinkingLevel,
  selectChatModel,
  selectChatSpeed,
  selectChatThinkingLevel
} from "../../core/agent/model-selection.js";
import { clampModelThinkingLevel, createPiRuntime, listModelThinkingLevels, listProviderModels, modelSupportsThinking } from "../../core/agent/pi-runtime.js";
import { clampModelSpeed, MODEL_SPEEDS, modelSupportsSpeed } from "../../core/agent/model-speed.js";
import { buildEffortPicker, buildModelPicker, buildSpeedPicker, reverseModelOrder } from "./model-picker.js";

function chatKey(chatId) {
  return String(chatId);
}

async function editOrReplyPicker(ctx, picker) {
  const extra = { reply_markup: picker.replyMarkup };
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (messageId) return ctx.api.editMessageText(ctx.chat.id, messageId, picker.text, extra);
  return ctx.reply(picker.text, extra);
}

async function editOrReplyText(ctx, text) {
  if (ctx.callbackQuery?.message?.message_id) {
    return ctx.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, text);
  }
  return ctx.reply(text);
}

function restorePreviousSelection(agentConfig, key, hadSelections, previousSelection) {
  if (previousSelection) {
    agentConfig.chatModels[key] = previousSelection;
  } else {
    delete agentConfig.chatModels[key];
    if (!hadSelections) delete agentConfig.chatModels;
  }
}

export function createTelegramModelControls({ config, saveConfig, agentManager, contextRoute }) {
  async function getProviderModels() {
    const runtime = createPiRuntime({
      provider: config.pi.provider,
      apiKey: config.pi.apiKey
    });
    return reverseModelOrder(listProviderModels(config.pi.provider, runtime));
  }

  async function showModelPicker(ctx, page = 0) {
    const route = contextRoute(ctx);
    const agentConfig = getAgentConfig(config);
    const picker = buildModelPicker({
      provider: agentConfig.provider,
      models: await getProviderModels(),
      selectedModelId: resolveChatModel(config, route.sessionId),
      selectedThinkingLevel: resolveChatThinkingLevel(config, route.sessionId),
      selectedSpeed: resolveChatSpeed(config, route.sessionId),
      page,
      pageSize: config.telegram.modelPickerPageSize
    });
    return editOrReplyPicker(ctx, picker);
  }

  async function showEffortPicker(ctx, { model, modelIndex, selectedThinkingLevel } = {}) {
    const route = contextRoute(ctx);
    const agentConfig = getAgentConfig(config);
    const models = await getProviderModels();
    const resolvedModel = model || models.find((item) => item.id === resolveChatModel(config, route.sessionId));
    if (!resolvedModel) throw new Error(`Model not found for provider ${agentConfig.provider}`);
    if (!modelSupportsThinking(resolvedModel)) {
      return editOrReplyText(ctx, `${resolvedModel.provider}/${resolvedModel.id} does not support effort levels.`);
    }
    const picker = buildEffortPicker({
      provider: resolvedModel.provider,
      modelId: resolvedModel.id,
      levels: listModelThinkingLevels(resolvedModel),
      selectedThinkingLevel: selectedThinkingLevel
        ?? clampModelThinkingLevel(resolvedModel, resolveChatThinkingLevel(config, route.sessionId)),
      modelIndex
    });
    return editOrReplyPicker(ctx, picker);
  }

  async function showSpeedPicker(ctx) {
    const route = contextRoute(ctx);
    const agentConfig = getAgentConfig(config);
    const models = await getProviderModels();
    const model = models.find((item) => item.id === resolveChatModel(config, route.sessionId));
    if (!model) throw new Error(`Model not found for provider ${agentConfig.provider}`);
    if (!modelSupportsSpeed(model)) {
      return editOrReplyText(ctx, `${model.provider}/${model.id} does not support speed 1.5x.`);
    }
    const picker = buildSpeedPicker({
      provider: model.provider,
      modelId: model.id,
      speeds: MODEL_SPEEDS,
      selectedSpeed: resolveChatSpeed(config, route.sessionId)
    });
    return editOrReplyPicker(ctx, picker);
  }

  async function persistChatModel(chatId, model, thinkingLevel) {
    const agentConfig = getAgentConfig(config);
    const key = chatKey(chatId);
    const hadSelections = Boolean(agentConfig.chatModels);
    const previousSelection = agentConfig.chatModels?.[key];
    const level = clampModelThinkingLevel(model, thinkingLevel ?? resolveChatThinkingLevel(config, chatId));
    const speed = clampModelSpeed(model, resolveChatSpeed(config, chatId));
    selectChatModel(config, chatId, model, { thinkingLevel: level, speed });
    try {
      await saveConfig(config);
    } catch (error) {
      restorePreviousSelection(agentConfig, key, hadSelections, previousSelection);
      throw error;
    }
    agentManager.resetSession(chatId);
    return level;
  }

  async function persistChatEffort(chatId, model, thinkingLevel) {
    const agentConfig = getAgentConfig(config);
    const key = chatKey(chatId);
    const hadSelections = Boolean(agentConfig.chatModels);
    const previousSelection = agentConfig.chatModels?.[key];
    const level = clampModelThinkingLevel(model, thinkingLevel);
    selectChatThinkingLevel(config, chatId, level);
    try {
      await saveConfig(config);
    } catch (error) {
      restorePreviousSelection(agentConfig, key, hadSelections, previousSelection);
      throw error;
    }
    return level;
  }

  async function persistChatSpeed(chatId, model, speed) {
    const agentConfig = getAgentConfig(config);
    const key = chatKey(chatId);
    const hadSelections = Boolean(agentConfig.chatModels);
    const previousSelection = agentConfig.chatModels?.[key];
    const level = clampModelSpeed(model, speed);
    await agentManager.setModelSpeed(chatId, level);
    selectChatSpeed(config, chatId, level);
    try {
      await saveConfig(config);
    } catch (error) {
      restorePreviousSelection(agentConfig, key, hadSelections, previousSelection);
      agentManager.clearSessionCache(chatId);
      throw error;
    }
    return level;
  }

  return {
    getProviderModels,
    showModelPicker,
    showEffortPicker,
    showSpeedPicker,
    persistChatModel,
    persistChatEffort,
    persistChatSpeed
  };
}
