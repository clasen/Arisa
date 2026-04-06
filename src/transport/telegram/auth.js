export async function authorizeChat({ config, chatId, saveConfig, chatMeta = null }) {
  config.telegram.chatMeta ||= {};

  if (chatMeta) {
    config.telegram.chatMeta[chatId] = {
      ...(config.telegram.chatMeta[chatId] || {}),
      ...chatMeta
    };
  }

  if (config.telegram.authorizedChatIds.includes(chatId)) {
    if (chatMeta) await saveConfig(config);
    return { ok: true, firstTime: false };
  }

  if (config.telegram.authorizedChatIds.length >= config.telegram.maxChatIds) {
    return { ok: false, reason: "max-chat-ids" };
  }

  config.telegram.authorizedChatIds.push(chatId);
  await saveConfig(config);
  return { ok: true, firstTime: true };
}
