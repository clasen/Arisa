const anonymousGroupBotId = 1087968824;

function asInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function workspaceGroupConfig(config, chatId) {
  const entry = config.telegram?.ownerWorkspaceGroups?.[String(chatId)];
  if (!entry || typeof entry !== "object") return null;
  const ownerChatId = asInteger(entry.ownerChatId);
  const generalTopicId = asInteger(entry.generalTopicId) ?? 1;
  if (ownerChatId == null || generalTopicId < 1) return null;
  return { ownerChatId, generalTopicId };
}

export function telegramMessageThreadId(ctx) {
  return asInteger(ctx?.message?.message_thread_id ?? ctx?.msg?.message_thread_id) ?? 1;
}

export function topicSessionId({ ownerChatId, groupChatId, threadId, generalTopicId = 1 }) {
  if (threadId === generalTopicId) return String(ownerChatId);
  return `${ownerChatId}--telegram-group-${Math.abs(groupChatId)}--topic-${threadId}`;
}

export async function verifyOwnerWorkspaceGroup({ api, groupChatId, ownerChatId, senderId }) {
  const [memberCount, administrators, me] = await Promise.all([
    api.getChatMemberCount(groupChatId),
    api.getChatAdministrators(groupChatId),
    api.getMe()
  ]);
  const creator = administrators.find((member) => member.status === "creator");
  const bot = administrators.find((member) => member.user?.id === me.id);
  const senderAllowed = senderId === ownerChatId || senderId === me.id || senderId === anonymousGroupBotId;
  if (memberCount !== 2) return { ok: false, reason: "member-count", memberCount };
  if (creator?.user?.id !== ownerChatId) return { ok: false, reason: "owner-mismatch", memberCount };
  if (!bot) return { ok: false, reason: "bot-not-admin", memberCount };
  if (!senderAllowed) return { ok: false, reason: "sender-mismatch", memberCount };
  return { ok: true, memberCount };
}

export async function resolveTelegramWorkspaceRoute({ config, api, ctx }) {
  const groupChatId = asInteger(ctx?.chat?.id);
  const configured = workspaceGroupConfig(config, groupChatId);
  if (!configured) {
    return {
      ok: true,
      workspace: false,
      sessionId: String(groupChatId),
      scopeChatId: groupChatId,
      transportChatId: groupChatId,
      threadId: null
    };
  }
  if (ctx.chat?.type !== "supergroup" || !ctx.chat?.is_forum) {
    return { ok: false, workspace: true, reason: "forum-required" };
  }
  const gate = await verifyOwnerWorkspaceGroup({
    api,
    groupChatId,
    ownerChatId: configured.ownerChatId,
    senderId: ctx?.from?.id
  });
  if (!gate.ok) return { ...gate, workspace: true };
  const topicThreadId = telegramMessageThreadId(ctx);
  const generalTopic = topicThreadId === configured.generalTopicId;
  return {
    ok: true,
    workspace: true,
    ownerChatId: configured.ownerChatId,
    sessionId: topicSessionId({
      ownerChatId: configured.ownerChatId,
      groupChatId,
      threadId: topicThreadId,
      generalTopicId: configured.generalTopicId
    }),
    scopeChatId: configured.ownerChatId,
    transportChatId: groupChatId,
    threadId: generalTopic ? null : topicThreadId,
    topicThreadId,
    generalTopicId: configured.generalTopicId
  };
}
