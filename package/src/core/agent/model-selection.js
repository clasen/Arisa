function chatKey(chatId) {
  return String(chatId);
}

export function getAgentConfig(config) {
  return config?.agent?.runtime === "prime" ? config.prime : config.pi;
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
      sessionRevision: 0
    };
  }
  const sessionRevision = normalizeSessionRevision(selection.sessionRevision);
  return {
    provider: selection.provider,
    model: selection.model,
    thinkingLevel: selection.thinkingLevel ?? agentConfig.thinkingLevel,
    sessionRevision
  };
}

export function resolveChatModel(config, chatId) {
  return resolveChatModelSelection(config, chatId).model;
}

export function resolveChatThinkingLevel(config, chatId) {
  return resolveChatModelSelection(config, chatId).thinkingLevel;
}

export function selectChatModel(config, chatId, model, { thinkingLevel } = {}) {
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
    sessionRevision: current.sessionRevision
  };
}
