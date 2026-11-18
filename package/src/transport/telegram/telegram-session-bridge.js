import path from "node:path";
import { InputFile } from "grammy";
import { cancelRestartReceipt, prepareRestartReceipt } from "../../runtime/restart-receipt.js";
import { isSilentReply } from "./prompt-builders.js";
import { renderTelegramHtml } from "./text-format.js";
import { resolveTelegramWorkspaceRoute, workspaceTopicSessionId } from "./workspace-group.js";

function deliveryMethod(artifact, method) {
  if (method) return method;
  if (artifact.metadata?.delivery?.method) return artifact.metadata.delivery.method;
  if (artifact.kind === "audio" || artifact.mimeType?.startsWith("audio/")) return "audio";
  if (artifact.kind === "image" || artifact.mimeType?.startsWith("image/")) return "photo";
  if (artifact.kind === "video" || artifact.mimeType?.startsWith("video/")) return "video";
  return "document";
}

function safeCaption(caption) {
  return caption && !/(^|\s)(\/[^\s]|[A-Za-z]:[\\/])/.test(caption) ? caption : undefined;
}

export function createTelegramSessionBridgeController({
  config,
  api,
  agentManager,
  artifactStore,
  sessionSeeds,
  workspaceTopics,
  getChatState,
  buildTopicInitializationHandoff,
  logger
}) {
  const sentReplyRoutes = new Map();

  function sentReplyKey(transportChatId, messageId) {
    return `${transportChatId}:${messageId}`;
  }

  function sentReplyRoute(transportChatId, messageId) {
    return sentReplyRoutes.get(sentReplyKey(transportChatId, messageId)) || null;
  }

  let topicIconStickers = null;

  function comparableEmoji(emoji) {
    return String(emoji || "").replace(/\uFE0F/g, "").trim();
  }

  async function topicIconId(emoji) {
    topicIconStickers ||= await api.getForumTopicIconStickers();
    const sticker = topicIconStickers.find((item) => comparableEmoji(item.emoji) === comparableEmoji(emoji));
    if (sticker) return sticker.custom_emoji_id;
    const available = [...new Set(topicIconStickers.map((item) => item.emoji))].join(" ");
    throw new Error(`Telegram has no topic icon for ${emoji}. Available icons: ${available}`);
  }

  function createWorkspaceAccessGuard(route) {
    return async () => {
      if (!route.workspace || route.privateTopics) return;
      const current = await resolveTelegramWorkspaceRoute({
        config,
        api,
        ctx: {
          chat: { id: route.transportChatId, type: "supergroup", is_forum: true },
          from: { id: route.ownerChatId },
          message: { message_thread_id: route.threadId }
        }
      });
      if (!current.ok) throw new Error("Owner-only workspace access is paused.");
    };
  }

  function createSessionBridge(route) {
    const messageOptions = (extra = {}) => route.workspace && route.threadId
      ? { ...extra, message_thread_id: route.threadId }
      : extra;
    const initializeForumTopic = async ({ messageThreadId, name, context }) => {
      if (!route.workspace) throw new Error("Telegram topic initialization is only available in a chat with topics.");
      await createWorkspaceAccessGuard(route)();
      const initializedSessionId = workspaceTopicSessionId(route, messageThreadId);
      if (initializedSessionId === String(route.ownerChatId)) {
        throw new Error("The General topic already uses the owner's private session and cannot be reinitialized here.");
      }
      const handoff = buildTopicInitializationHandoff({ name, context });
      await workspaceTopics.upsertTopic(route.ownerChatId, route.transportChatId, {
        threadId: messageThreadId,
        name,
        description: context,
        source: "arisa-initialized"
      });
      await sessionSeeds.set(initializedSessionId, handoff);
      agentManager.resetSession(initializedSessionId, { handoff });
      await agentManager.waitForSessionClose(initializedSessionId);
      return {
        ok: true,
        chatId: route.transportChatId,
        messageThreadId,
        sessionId: initializedSessionId,
        name,
        initialized: true
      };
    };
    return {
      sendMedia: async (filePath, { method = "audio", caption, filename } = {}) => {
        logger?.log("telegram", `sending ${method} reply for chat ${route.transportChatId}`);
        const input = new InputFile(filePath, filename || undefined);
        const options = messageOptions({ caption });
        if (method === "voice") return api.sendVoice(route.transportChatId, input, options);
        if (method === "document") return api.sendDocument(route.transportChatId, input, options);
        if (method === "photo" || method === "image") return api.sendPhoto(route.transportChatId, input, options);
        if (method === "video") return api.sendVideo(route.transportChatId, input, options);
        return api.sendAudio(route.transportChatId, input, options);
      },
      createForumTopic: async (name, context, emoji = "") => {
        if (!route.workspace) throw new Error("Telegram topic creation is only available in a chat with topics.");
        await createWorkspaceAccessGuard(route)();
        const topic = await api.createForumTopic(
          route.transportChatId,
          name,
          emoji ? { icon_custom_emoji_id: await topicIconId(emoji) } : undefined
        );
        return initializeForumTopic({
          messageThreadId: topic.message_thread_id,
          name: topic.name,
          context
        });
      },
      initializeForumTopic,
      renameForumTopic: async ({ messageThreadId = route.threadId, name }) => {
        if (!route.workspace) throw new Error("Telegram topic renaming is only available in a chat with topics.");
        if (!Number.isSafeInteger(messageThreadId)) {
          throw new Error("Pass messageThreadId to rename a topic from outside it.");
        }
        await createWorkspaceAccessGuard(route)();
        await api.editForumTopic(route.transportChatId, messageThreadId, { name });
        const topic = await workspaceTopics.upsertTopic(route.ownerChatId, route.transportChatId, {
          threadId: messageThreadId,
          name,
          source: "arisa-renamed"
        });
        return { ok: true, chatId: route.transportChatId, messageThreadId, name: topic.name };
      },
      setForumTopicIcon: async ({ messageThreadId = route.threadId, emoji }) => {
        if (!route.workspace) throw new Error("Telegram topic icons are only available in a chat with topics.");
        if (!Number.isSafeInteger(messageThreadId)) {
          throw new Error("Pass messageThreadId to change a topic icon from outside it.");
        }
        await createWorkspaceAccessGuard(route)();
        await api.editForumTopic(route.transportChatId, messageThreadId, {
          icon_custom_emoji_id: emoji ? await topicIconId(emoji) : ""
        });
        return { ok: true, chatId: route.transportChatId, messageThreadId, emoji };
      },
      deleteForumTopic: async ({ messageThreadId }) => {
        if (!route.workspace) throw new Error("Telegram topic deletion is only available in a chat with topics.");
        if (messageThreadId === route.threadId) {
          throw new Error("A topic cannot be deleted from inside it. Ask the user to request it from General or another topic.");
        }
        await createWorkspaceAccessGuard(route)();
        await api.deleteForumTopic(route.transportChatId, messageThreadId);
        await workspaceTopics.removeTopic(route.ownerChatId, route.transportChatId, messageThreadId);
        const deletedSessionId = workspaceTopicSessionId(route, messageThreadId);
        await sessionSeeds.clear(deletedSessionId);
        agentManager.resetSession(deletedSessionId);
        return { ok: true, chatId: route.transportChatId, messageThreadId, deleted: true };
      },
      prepareRestartReceipt: (summary) => prepareRestartReceipt({
        transportChatId: route.transportChatId,
        threadId: route.threadId
      }, { reason: String(summary || "Agent-requested restart").trim() }),
      cancelRestartReceipt,
      getTaskContext: () => route.workspace && (!route.privateTopics || route.threadId) ? {
        transport: "telegram",
        destination: {
          chatId: route.transportChatId,
          threadId: route.topicThreadId
        }
      } : null,
      getAgentTaskExecution: () => route.agentTaskExecution || null
    };
  }

  async function sendTextReply({ sendText, sendDocument, chatId, route = null, artifactChatId = chatId, text }) {
    const maxInlineReplyLength = 3500;
    if (isSilentReply(text)) {
      logger?.log("telegram", `suppressing silent reply for chat ${chatId}`);
      return;
    }

    if (text.length > maxInlineReplyLength) {
      logger?.log("telegram", `sending long reply as markdown attachment for chat ${chatId}`);
      const chatArtifactStore = artifactStore.forChat(artifactChatId);
      const artifact = await chatArtifactStore.createGeneratedFile({
        fileName: `reply-${Date.now()}.md`,
        content: text,
        kind: "document",
        mimeType: "text/markdown",
        source: { type: "assistant", chatId },
        metadata: { delivery: "telegram-document" }
      });
      await sendDocument(new InputFile(artifact.path, path.basename(artifact.path)), {
        caption: "Response attached as Markdown."
      });
      return;
    }

    logger?.log("telegram", `sending text reply for chat ${chatId}`);
    const sent = await sendText(renderTelegramHtml(text), { parse_mode: "HTML" });
    if (sent?.message_id) {
      const messages = getChatState(chatId).assistantMessages;
      messages.set(sent.message_id, text);
      while (messages.size > 50) messages.delete(messages.keys().next().value);
      if (route?.workspace) {
        sentReplyRoutes.set(sentReplyKey(route.transportChatId, sent.message_id), route);
        while (sentReplyRoutes.size > 200) sentReplyRoutes.delete(sentReplyRoutes.keys().next().value);
      }
    }
  }

  function installArtifactDeliveryHandler() {
    agentManager.setArtifactDeliveryHandler?.(async ({ chatId, artifact, caption, method }) => {
      const resolvedMethod = deliveryMethod(artifact, method);
      await createSessionBridge({
        workspace: false,
        sessionId: String(chatId),
        scopeChatId: chatId,
        transportChatId: chatId,
        threadId: null
      }).sendMedia(artifact.path, {
        method: resolvedMethod,
        caption: safeCaption(caption),
        filename: path.basename(artifact.path)
      });
      return { ok: true, artifactId: artifact.id, method: resolvedMethod };
    });
  }

  return {
    createSessionBridge,
    createWorkspaceAccessGuard,
    installArtifactDeliveryHandler,
    sendTextReply,
    sentReplyRoute
  };
}
