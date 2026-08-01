function chatKey(chatId) {
  return String(chatId);
}

function normalizeSessionRevision(sessionRevision) {
  if (sessionRevision == null) return 0;
  if (!Number.isSafeInteger(sessionRevision) || sessionRevision < 0) {
    throw new Error("Invalid model session revision");
  }
  return sessionRevision;
}

export function resolveChatModelSelection(config, chatId) {
  const selection = config.pi.chatModels?.[chatKey(chatId)];
  if (!selection || selection.provider !== config.pi.provider) {
    return {
      provider: config.pi.provider,
      model: config.pi.model,
      thinkingLevel: config.pi.thinkingLevel,
      sessionRevision: 0
    };
  }
  const sessionRevision = normalizeSessionRevision(selection.sessionRevision);
  return {
    provider: selection.provider,
    model: selection.model,
    thinkingLevel: selection.thinkingLevel ?? config.pi.thinkingLevel,
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
  if (model.provider !== config.pi.provider) {
    throw new Error(`Cannot select model from provider ${model.provider}; active provider is ${config.pi.provider}`);
  }
  config.pi.chatModels ||= {};
  const key = chatKey(chatId);
  const sessionRevision = (config.pi.chatModels[key]?.sessionRevision || 0) + 1;
  config.pi.chatModels[key] = {
    provider: model.provider,
    model: model.id,
    thinkingLevel,
    sessionRevision
  };
}

export function selectChatThinkingLevel(config, chatId, thinkingLevel) {
  config.pi.chatModels ||= {};
  const key = chatKey(chatId);
  const current = resolveChatModelSelection(config, chatId);
  config.pi.chatModels[key] = {
    provider: current.provider,
    model: current.model,
    thinkingLevel,
    sessionRevision: current.sessionRevision
  };
}
