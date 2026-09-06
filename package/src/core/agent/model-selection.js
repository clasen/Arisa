import { modelFastSpeed, normalizeModelSpeed } from "./model-speed.js";

function chatKey(chatId) {
  return String(chatId);
}

export function getAgentConfig(config) {
  return config.pi;
}

function normalizeSessionRevision(sessionRevision) {
  if (sessionRevision == null) return 0;
  if (!Number.isSafeInteger(sessionRevision) || sessionRevision < 0) {
    throw new Error("Invalid model session revision");
  }
  return sessionRevision;
}

export function resolveChatModelSelection(config, chatId) {
  const agentConfig = getAgentConfig(config);
  const selection = agentConfig.chatModels?.[chatKey(chatId)];
  if (!selection || selection.provider !== agentConfig.provider) {
    return {
      provider: agentConfig.provider,
      model: agentConfig.model,
      thinkingLevel: agentConfig.thinkingLevel,
      ...(agentConfig.speed !== undefined ? { speed: normalizeModelSpeed(agentConfig.speed) } : {}),
      sessionRevision: 0
    };
  }
  const sessionRevision = normalizeSessionRevision(selection.sessionRevision);
  return {
    provider: selection.provider,
    model: selection.model,
    thinkingLevel: selection.thinkingLevel ?? agentConfig.thinkingLevel,
    ...(agentConfig.speed !== undefined
      ? { speed: normalizeModelSpeed(selection.speed ?? agentConfig.speed) }
      : {}),
    sessionRevision
  };
}

export function resolveChatModel(config, chatId) {
  return resolveChatModelSelection(config, chatId).model;
}

export function resolveChatThinkingLevel(config, chatId) {
  return resolveChatModelSelection(config, chatId).thinkingLevel;
}

export function resolveChatSpeed(config, chatId) {
  const { speed, model } = resolveChatModelSelection(config, chatId);
  if (speed === undefined) throw new Error("Model speed is not configured for the active runtime");
  // Preserve legacy fast selections while displaying the model-specific multiplier.
  return speed > 1 ? modelFastSpeed(model) : speed;
}

export function selectChatModel(config, chatId, model, { thinkingLevel, speed } = {}) {
  const agentConfig = getAgentConfig(config);
  if (model.provider !== agentConfig.provider) {
    throw new Error(`Cannot select model from provider ${model.provider}; active provider is ${agentConfig.provider}`);
  }
  agentConfig.chatModels ||= {};
  const key = chatKey(chatId);
  const sessionRevision = (agentConfig.chatModels[key]?.sessionRevision || 0) + 1;
  agentConfig.chatModels[key] = {
    provider: model.provider,
    model: model.id,
    thinkingLevel,
    ...(agentConfig.speed !== undefined
      ? { speed: normalizeModelSpeed(speed ?? resolveChatModelSelection(config, chatId).speed) }
      : {}),
    sessionRevision
  };
}

export function selectChatThinkingLevel(config, chatId, thinkingLevel) {
  const agentConfig = getAgentConfig(config);
  agentConfig.chatModels ||= {};
  const key = chatKey(chatId);
  const current = resolveChatModelSelection(config, chatId);
  agentConfig.chatModels[key] = {
    provider: current.provider,
    model: current.model,
    thinkingLevel,
    ...(current.speed !== undefined ? { speed: current.speed } : {}),
    sessionRevision: current.sessionRevision
  };
}

export function selectChatSpeed(config, chatId, speed) {
  const agentConfig = getAgentConfig(config);
  if (agentConfig.speed === undefined) {
    throw new Error("Model speed is not configured for the active runtime");
  }
  agentConfig.chatModels ||= {};
  const key = chatKey(chatId);
  const current = resolveChatModelSelection(config, chatId);
  agentConfig.chatModels[key] = {
    provider: current.provider,
    model: current.model,
    thinkingLevel: current.thinkingLevel,
    speed: normalizeModelSpeed(speed),
    sessionRevision: current.sessionRevision
  };
}
