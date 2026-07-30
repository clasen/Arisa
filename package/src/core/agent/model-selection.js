function chatKey(chatId) {
  return String(chatId);
}

export function resolveChatModelSelection(config, chatId) {
  const selection = config.pi.chatModels?.[chatKey(chatId)];
  if (!selection || selection.provider !== config.pi.provider) {
    return {
      provider: config.pi.provider,
      model: config.pi.model,
      sessionRevision: 0
    };
  }
  if (!Number.isSafeInteger(selection.sessionRevision) || selection.sessionRevision <= 0) {
    throw new Error(`Invalid model session revision for chat ${chatId}`);
  }
  return selection;
}

export function resolveChatModel(config, chatId) {
  return resolveChatModelSelection(config, chatId).model;
}

export function selectChatModel(config, chatId, model) {
  if (model.provider !== config.pi.provider) {
    throw new Error(`Cannot select model from provider ${model.provider}; active provider is ${config.pi.provider}`);
  }
  config.pi.chatModels ||= {};
  const key = chatKey(chatId);
  const sessionRevision = (config.pi.chatModels[key]?.sessionRevision || 0) + 1;
  config.pi.chatModels[key] = {
    provider: model.provider,
    model: model.id,
    sessionRevision
  };
}
