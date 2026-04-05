export async function authorizeChat({ config, chatId, saveConfig }) {
  if (config.telegram.authorizedChatIds.includes(chatId)) {
    return { ok: true, firstTime: false };
  }

  if (config.telegram.authorizedChatIds.length >= config.telegram.maxChatIds) {
    return { ok: false, reason: "max-chat-ids" };
  }

  config.telegram.authorizedChatIds.push(chatId);
  await saveConfig(config);
  return { ok: true, firstTime: true };
}
