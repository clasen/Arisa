import { Bot, InputFile } from "grammy";
import path from "node:path";
import { authorizeChat } from "./auth.js";
import { captureIncomingArtifact } from "./media.js";
import { buildDeviceCodeTelegramMessage } from "./device-code-message.js";
import { renderTelegramHtml } from "./text-format.js";
import { buildPiAuthRecoveryBlockedMessage, buildPiAuthTelegramMessage, getErrorMessage, getPiAuthIssue, getPiAuthStatus } from "../../core/agent/auth-flow.js";
import { createPiOAuthLogin } from "../../core/agent/pi-auth-login.js";
import { resolveChatSpeed } from "../../core/agent/model-selection.js";
import { SessionSeedStore } from "../../core/conversation/session-seed-store.js";
import { formatDoctorReport } from "../../runtime/doctor.js";
import { formatToolUsageReport } from "../../runtime/tool-usage-report.js";
import { ToolResourceNoteStore } from "../../core/tools/tool-resource-note-store.js";
import { formatUpdateReport } from "../../runtime/update-manager.js";
import { cancelRestartReceipt, deliverRestartReceipt, prepareRestartReceipt } from "../../runtime/restart-receipt.js";
import { buildUpdatePicker, createTelegramUpdateCallbackHandler } from "./update-command.js";
import { createTelegramModelControls } from "./model-controls.js";
import { createTelegramModelCallbackHandler } from "./model-callback.js";
import { createTelegramTaskDispatcher } from "./task-dispatcher.js";
import { resolveTelegramWorkspaceRoute, topicSessionId } from "./workspace-group.js";
import {
  buildNewSessionPrompt,
  buildPrompt,
  buildReactionPrompt,
  buildSessionHandoffPrompt,
  buildStartupMessage,
  collectText,
  getIncomingMessageText,
  isScheduledTaskPrompt,
  isSilentReply,
  normalizeIncomingArtifact,
  sanitizeSessionHandoff,
  scheduledPromptSpeedOptions,
  shouldIncludeArtifactReference,
  withPromptSpeed
} from "./prompt-builders.js";
import {
  createChatStateStore,
  drainChatPromptQueue,
  queueChatPrompt,
  resolveTelegramBusyMessageMode,
  routeBusyPrompt
} from "./chat-queue.js";

export {
  createChatStateStore,
  drainChatPromptQueue,
  queueChatPrompt,
  resolveTelegramBusyMessageMode,
  routeBusyPrompt
} from "./chat-queue.js";

export {
  buildAsyncTaskPrompt,
  buildPrompt,
  buildReactionPrompt,
  collectText,
  isScheduledTaskPrompt,
  isSilentReply,
  scheduledPromptSpeedOptions,
  shouldIncludeArtifactReference,
  withPromptSpeed
} from "./prompt-builders.js";

export function isProcessableTelegramMessage(message = {}) {
  return Boolean(
    String(message.text || "").trim()
    || message.voice
    || message.audio
    || message.video
    || message.document
    || message.photo?.length
    || message.location
    || message.venue
  );
}

export function buildTopicInitializationHandoff({ name, context }) {
  return [
    `Telegram topic: ${String(name || "").trim()}`,
    "This topic has an isolated conversation session.",
    "Use the following as background context. Do not repeat it unless the user asks.",
    String(context || "").trim()
  ].filter(Boolean).join("\n\n");
}

export const telegramCommands = Object.freeze([
  { command: "new", description: "New chat context" },
  { command: "restart", description: "Restart Arisa" },
  { command: "doctor", description: "Check runtime health" },
  { command: "update", description: "Check and apply updates" },
  { command: "tools", description: "Tool usage counts" },
  { command: "model", description: "Choose chat model" },
  { command: "effort", description: "Choose reasoning effort" },
  { command: "speed", description: "Choose model speed" },
  { command: "auth", description: "Authentication status" }
]);

export function createTelegramRestartHandler({ authorize, requestRestart, logger }) {
  if (typeof authorize !== "function" || typeof requestRestart !== "function") {
    throw new Error("Telegram restart requires authorization and restart handoff functions");
  }

  let restartRequested = false;
  return async (ctx) => {
    const auth = await authorize(ctx);
    if (!auth.ok) return;

    if (restartRequested) {
      await ctx.reply("An Arisa restart is already in progress.");
      return;
    }

    restartRequested = true;
    try {
      await ctx.reply("Arisa is restarting. I'll be back shortly.");
      const handoff = await requestRestart(ctx);
      logger?.log("telegram", `restart handed off to process ${handoff.pid}`);
    } catch (error) {
      restartRequested = false;
      logger?.error("telegram", `restart handoff failed: ${getErrorMessage(error)}`);
      await ctx.reply(`Arisa could not be restarted: ${getErrorMessage(error)}`);
    }
  };
}

function getTelegramCommand(ctx) {
  const text = ctx.message?.text || "";
  const entity = ctx.message?.entities?.[0];
  if (entity?.type !== "bot_command" || entity.offset !== 0 || !text.startsWith("/")) return "";
  return text.slice(1, entity.length).split("@")[0].trim().toLowerCase();
}

export async function startTelegramTyping(ctx) {
  const options = ctx.message?.message_thread_id
    ? { message_thread_id: ctx.message.message_thread_id }
    : undefined;
  await ctx.api.sendChatAction(ctx.chat.id, "typing", options).catch(() => {});
  const timer = setInterval(() => {
    ctx.api.sendChatAction(ctx.chat.id, "typing", options).catch(() => {});
  }, 4000);
  return () => clearInterval(timer);
}

export async function ensureQueuedTelegramTyping(chatState, ctx) {
  if (chatState.stopQueuedTyping) return;
  chatState.stopQueuedTyping = await startTelegramTyping(ctx);
}

export function stopQueuedTelegramTyping(chatState) {
  chatState.stopQueuedTyping?.();
  chatState.stopQueuedTyping = null;
}

async function withTyping(ctx, work) {
  const stopTyping = await startTelegramTyping(ctx);
  try {
    return await work();
  } finally {
    stopTyping();
  }
}

export { closeModelPicker } from "./model-callback.js";

export async function createTelegramBot({ config, artifactStore, toolRegistry, taskStore, agentManager, saveConfig, updateConfig, doctor, checkUpdates, updateCore, updateTools, requestRestart, logger }) {
  const resourceNotes = new ToolResourceNoteStore();
  const bot = new Bot(config.telegram.token);
  const perChatState = createChatStateStore();
  const sessionSeeds = new SessionSeedStore();
  const notifiedPromptErrors = new WeakSet();
  const authRenewals = new Map();
  const workspaceRoutes = new WeakMap();
  const workspaceGateStates = new Map();
  let piAuthIssue = null;
  let taskTimer = null;

  const requestRestartWithReceipt = async (ctx, reason = "Telegram restart") => {
    const route = contextRoute(ctx);
    const receipt = await prepareRestartReceipt({
      transportChatId: route.transportChatId,
      threadId: route.threadId
    }, { reason });
    try {
      return await requestRestart();
    } catch (error) {
      await cancelRestartReceipt(receipt.id).catch(() => {});
      throw error;
    }
  };
  const handleRestartCommand = createTelegramRestartHandler({
    authorize: authorizeContext,
    requestRestart: (ctx) => requestRestartWithReceipt(ctx, "Telegram /restart"),
    logger
  });
  const handleUpdateCallback = createTelegramUpdateCallbackHandler({
    authorize: authorizeContext,
    updateCore,
    updateTools,
    requestRestart: (ctx) => requestRestartWithReceipt(ctx, "Telegram update restart"),
    logger
  });

  function chatKey(chatId) {
    return String(chatId);
  }

  function wasPromptErrorNotified(error) {
    return error instanceof Error && notifiedPromptErrors.has(error);
  }

  function markPromptErrorNotified(error) {
    if (error instanceof Error) notifiedPromptErrors.add(error);
  }

  function rememberPiAuthIssue(error) {
    const issue = getPiAuthIssue(error);
    if (issue) piAuthIssue = issue;
    return issue;
  }

  async function notifyPiAuthIssueIfNeeded(chatId, error) {
    const issue = rememberPiAuthIssue(error);
    if (!issue) return false;

    try {
      await bot.api.sendMessage(chatId, buildPiAuthTelegramMessage({ config, chatId, issue }));
      markPromptErrorNotified(error);
      return true;
    } catch (notifyError) {
      logger?.error("telegram", `auth issue notice failed for chat ${chatId}: ${getErrorMessage(notifyError)}`);
      return false;
    }
  }

  function selectTelegramLoginOption(options = []) {
    return options.find((option) => /device/i.test(`${option.id} ${option.label}`))
      || options.find((option) => /browser|oauth|web/i.test(`${option.id} ${option.label}`))
      || options[0]
      || null;
  }

  async function finishAuthRenewal(chatId, renewal) {
    try {
      await renewal.promise;
      await agentManager.validateAgent();
      agentManager.clearSessionCache(chatId);
      piAuthIssue = null;
      logger?.log("telegram", `Pi auth renewal completed for chat ${chatId}`);
      await bot.api.sendMessage(chatId, buildPiAuthTelegramMessage({ config, chatId, verified: true }));
    } catch (error) {
      const issue = rememberPiAuthIssue(error) || { kind: "validation-failed", message: getErrorMessage(error) };
      piAuthIssue = issue;
      logger?.error("telegram", `Pi auth renewal failed for chat ${chatId}: ${getErrorMessage(error)}`);
      await bot.api.sendMessage(chatId, buildPiAuthTelegramMessage({ config, chatId, issue })).catch((notifyError) => {
        logger?.error("telegram", `auth renewal failure notice failed for chat ${chatId}: ${getErrorMessage(notifyError)}`);
      });
    } finally {
      authRenewals.delete(chatKey(chatId));
    }
  }

  async function startAuthRenewal(chatId) {
    const key = chatKey(chatId);
    const existing = authRenewals.get(key);
    if (existing) {
      return { started: false, renewal: existing };
    }

    const renewal = createPiOAuthLogin({
      provider: config.pi.provider,
      onSelect: async ({ message, options }) => {
        const selected = selectTelegramLoginOption(options);
        if (!selected) return undefined;
        logger?.log("telegram", `Pi auth option for chat ${chatId}: ${selected.id}`);
        await bot.api.sendMessage(chatId, `${message}\nUsing: ${selected.label || selected.id}`);
        return selected.id;
      },
      onAuth: async ({ url, instructions }) => {
        await bot.api.sendMessage(chatId, [
          instructions || "Open this URL to continue Pi authentication:",
          url,
          "After login, paste the full redirect URL back here."
        ].join("\n"));
      },
      onDeviceCode: async ({ userCode, verificationUri, expiresInSeconds }) => {
        const payload = buildDeviceCodeTelegramMessage({ userCode, verificationUri, expiresInSeconds });
        const { text, ...options } = payload;
        await bot.api.sendMessage(chatId, text, options);
      },
      onPrompt: async ({ message, controller }) => {
        await bot.api.sendMessage(chatId, `${message}\nReply here with the value.`);
        return controller.waitForManualCode();
      },
      onProgress: (message) => {
        if (message) logger?.log("telegram", `Pi auth progress for chat ${chatId}: ${message}`);
      }
    });

    authRenewals.set(key, renewal);
    finishAuthRenewal(chatId, renewal);
    return { started: true, renewal };
  }

  async function submitAuthRenewalInput(ctx) {
    const renewal = authRenewals.get(chatKey(ctx.chat.id));
    const text = getIncomingMessageText(ctx.message).trim();
    if (!renewal || !renewal.manualInputRequested || !text) return false;

    if (!renewal.submitManualCode(text)) return false;
    await ctx.reply("Got it. Finishing Pi login now...");
    return true;
  }

  function getIncomingChatMeta(ctx) {
    return {
      languageCode: ctx.from?.language_code || "",
      username: ctx.from?.username || "",
      firstName: ctx.from?.first_name || "",
      lastName: ctx.from?.last_name || ""
    };
  }

  async function authorizeContext(ctx) {
    const route = await resolveTelegramWorkspaceRoute({ config, api: ctx.api, ctx });
    if (!route.workspace) {
      const auth = await authorizeChat({ config, chatId: ctx.chat.id, saveConfig, chatMeta: getIncomingChatMeta(ctx) });
      if (auth.ok) workspaceRoutes.set(ctx, route);
      return auth;
    }

    const gateKey = String(ctx.chat.id);
    const previous = workspaceGateStates.get(gateKey);
    if (!route.ok) {
      workspaceGateStates.set(gateKey, route.reason || "locked");
      if (previous !== (route.reason || "locked")) {
        await ctx.reply("Private workspace access is paused because this forum is no longer owner-only.").catch(() => {});
      }
      return { ok: false, reason: route.reason || "workspace-locked" };
    }
    if (!(config.telegram.authorizedChatIds || []).includes(route.ownerChatId)) {
      return { ok: false, reason: "owner-not-authorized" };
    }
    workspaceRoutes.set(ctx, route);
    workspaceGateStates.set(gateKey, "ready");
    if (previous && previous !== "ready") {
      await ctx.reply("Private workspace access restored.").catch(() => {});
    }
    return { ok: true, firstTime: false, workspace: true };
  }

  function contextRoute(ctx) {
    return workspaceRoutes.get(ctx) || {
      ok: true,
      workspace: false,
      sessionId: String(ctx.chat.id),
      scopeChatId: ctx.chat.id,
      transportChatId: ctx.chat.id,
      threadId: null
    };
  }

  function getChatState(chatId) {
    return perChatState.get(chatId);
  }

  const {
    getProviderModels,
    showModelPicker,
    showEffortPicker,
    showSpeedPicker,
    persistChatModel,
    persistChatEffort,
    persistChatSpeed
  } = createTelegramModelControls({ config, saveConfig, agentManager, contextRoute });

  function modelSelectionFor(chatId) {
    const selection = config.pi.chatModels?.[chatKey(chatId)];
    return selection?.provider === config.pi.provider ? selection : null;
  }

  async function ensureWorkspaceTopicModelSelection(route) {
    if (!route.workspace || chatKey(route.sessionId) === chatKey(route.ownerChatId)) return;
    if (modelSelectionFor(route.sessionId)) return;
    const inherited = modelSelectionFor(route.scopeChatId) || modelSelectionFor(route.transportChatId);
    if (!inherited) return;
    config.pi.chatModels ||= {};
    config.pi.chatModels[chatKey(route.sessionId)] = {
      ...inherited,
      sessionRevision: 0
    };
    await saveConfig(config);
    logger?.log("telegram", `inherited model ${inherited.model} for workspace topic session ${route.sessionId}`);
  }

  async function buildIncomingPrompt(ctx, route = contextRoute(ctx)) {
    logger?.log("telegram", `message ${ctx.msg.message_id} in chat ${route.transportChatId} session ${route.sessionId}`);
    const chatArtifactStore = artifactStore.forChat(route.scopeChatId);
    const artifact = await captureIncomingArtifact(ctx, artifactStore, { storageChatId: route.scopeChatId });
    if (artifact) logger?.log("telegram", `captured artifact ${artifact.kind}${artifact.id ? ` ${artifact.id}` : ""}`);
    const { transcript, toolResult, normalizationRequired } = await normalizeIncomingArtifact({
      artifact,
      toolRegistry,
      chatArtifactStore,
      chatId: route.scopeChatId
    });
    if (transcript) logger?.log("telegram", `media transcribed to artifact ${transcript.id}`);
    if (normalizationRequired && !transcript) {
      logger?.log("telegram", `media normalization unavailable for chat ${route.transportChatId}: ${toolResult?.error || toolResult?.missingConfig?.join(", ") || "unknown error"}`);
    }
    return buildPrompt({ ctx, artifact, transcript, toolResult });
  }

  async function sendTextReply({ sendText, sendDocument, chatId, artifactChatId = chatId, text }) {
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
    }
  }

  function createWorkspaceAccessGuard(route) {
    return async () => {
      if (!route.workspace) return;
      const current = await resolveTelegramWorkspaceRoute({
        config,
        api: bot.api,
        ctx: {
          chat: { id: route.transportChatId, type: "supergroup", is_forum: true },
          from: { id: route.ownerChatId },
          message: { message_thread_id: route.threadId }
        }
      });
      if (!current.ok) throw new Error("Owner-only workspace access is paused.");
    };
  }

  function createTelegramSessionBridge(route) {
    const messageOptions = (extra = {}) => route.workspace && route.threadId
      ? { ...extra, message_thread_id: route.threadId }
      : extra;
    const initializeForumTopic = async ({ messageThreadId, name, context }) => {
      if (!route.workspace) throw new Error("Telegram topic initialization is only available from the owner workspace forum.");
      await createWorkspaceAccessGuard(route)();
      const initializedSessionId = topicSessionId({
        ownerChatId: route.ownerChatId,
        groupChatId: route.transportChatId,
        threadId: messageThreadId,
        generalTopicId: route.generalTopicId
      });
      if (initializedSessionId === String(route.ownerChatId)) {
        throw new Error("The General topic already uses the owner's private session and cannot be reinitialized here.");
      }
      const handoff = buildTopicInitializationHandoff({ name, context });
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
        if (method === "voice") return bot.api.sendVoice(route.transportChatId, input, options);
        if (method === "document") return bot.api.sendDocument(route.transportChatId, input, options);
        if (method === "photo" || method === "image") return bot.api.sendPhoto(route.transportChatId, input, options);
        if (method === "video") return bot.api.sendVideo(route.transportChatId, input, options);
        return bot.api.sendAudio(route.transportChatId, input, options);
      },
      createForumTopic: async (name, context) => {
        if (!route.workspace) throw new Error("Telegram topic creation is only available from the owner workspace forum.");
        await createWorkspaceAccessGuard(route)();
        const topic = await bot.api.createForumTopic(route.transportChatId, name);
        return initializeForumTopic({
          messageThreadId: topic.message_thread_id,
          name: topic.name,
          context
        });
      },
      initializeForumTopic,
      prepareRestartReceipt: (summary) => prepareRestartReceipt({
        transportChatId: route.transportChatId,
        threadId: route.threadId
      }, { reason: String(summary || "Agent-requested restart").trim() }),
      cancelRestartReceipt,
      getTaskContext: () => route.workspace ? {
        transportChatId: route.transportChatId,
        messageThreadId: route.topicThreadId
      } : null
    };
  }

  agentManager.setArtifactDeliveryHandler?.(async ({ chatId, artifact, caption, method }) => {
    const resolvedMethod = method
      || artifact.metadata?.delivery?.method
      || (artifact.kind === "audio" || artifact.mimeType?.startsWith("audio/") ? "audio"
        : artifact.kind === "image" || artifact.mimeType?.startsWith("image/") ? "photo"
          : artifact.kind === "video" || artifact.mimeType?.startsWith("video/") ? "video"
            : "document");
    const safeCaption = caption && !/(^|\s)(\/[^\s]|[A-Za-z]:[\\/])/.test(caption) ? caption : undefined;
    await createTelegramSessionBridge({
      workspace: false,
      sessionId: String(chatId),
      scopeChatId: chatId,
      transportChatId: chatId,
      threadId: null
    }).sendMedia(artifact.path, {
      method: resolvedMethod,
      caption: safeCaption,
      filename: path.basename(artifact.path)
    });
    return { ok: true, artifactId: artifact.id, method: resolvedMethod };
  });

  async function processPromptForChat({ chatId, prompt, ctx = null }) {
    const route = ctx ? contextRoute(ctx) : {
      workspace: false,
      sessionId: String(chatId),
      scopeChatId: chatId,
      transportChatId: chatId,
      threadId: null
    };
    const sessionId = route.sessionId;
    const bridge = createTelegramSessionBridge(route);
    const messageOptions = (extra = {}) => route.workspace && route.threadId
      ? { ...extra, message_thread_id: route.threadId }
      : extra;
    const work = async () => {
      await ensureWorkspaceTopicModelSelection(route);
      if (route.workspace && route.threadId) {
        const handoff = await sessionSeeds.consume(sessionId);
        if (handoff) {
          agentManager.resetSession(sessionId, { handoff });
          await agentManager.waitForSessionClose(sessionId);
        }
      }
      const { session, speedController } = await agentManager.getSessionContext(sessionId, bridge, {
        scopeChatId: route.scopeChatId,
        accessGuard: createWorkspaceAccessGuard(route)
      });
      let text = "";
      const chatState = getChatState(sessionId);
      chatState.activeSession = session;
      chatState.activeRoute = route;
      try {
        text = await withPromptSpeed(scheduledPromptSpeedOptions({
          prompt,
          session,
          speedController,
          configuredSpeed: resolveChatSpeed(config, sessionId)
        }), () => collectText(session, prompt, {
          logger,
          chatId: sessionId,
          onSlowPrompt: () => bot.api.sendMessage(
            route.transportChatId,
            "This is taking longer than 5 minutes, so I will keep the current session running instead of starting over. Send /new if you want to abandon it and start fresh.",
            messageOptions()
          )
        }));
      } catch (error) {
        agentManager.resetSession(sessionId);
        throw error;
      } finally {
        if (chatState.activeSession === session) chatState.activeSession = null;
        chatState.activeRoute = null;
      }
      if (text) {
        await createWorkspaceAccessGuard(route)();
        await sendTextReply({
          sendText: (message, extra) => bot.api.sendMessage(route.transportChatId, message, messageOptions(extra)),
          sendDocument: (file, extra) => bot.api.sendDocument(route.transportChatId, file, messageOptions(extra)),
          chatId: sessionId,
          artifactChatId: route.scopeChatId,
          text
        });
      }
    };

    if (ctx) return withTyping(ctx, work);
    return work();
  }

  async function enqueuePrompt({ chatId, prompt, label, ctx = null, replaceQueued = false, busyMessageMode = "queue" }) {
    const chatState = getChatState(chatId);

    if (chatState.processing) {
      const incomingRoute = ctx ? contextRoute(ctx) : null;
      const activeRoute = chatState.activeRoute;
      const sameDelivery = !incomingRoute || !activeRoute || (
        incomingRoute.transportChatId === activeRoute.transportChatId
        && incomingRoute.threadId === activeRoute.threadId
      );
      const routed = await routeBusyPrompt({
        chatState,
        prompt,
        mode: sameDelivery ? busyMessageMode : "queue",
        replaceQueued,
        ctx
      });
      if (routed.disposition === "steered") {
        logger?.log("telegram", `chat ${chatId} busy, steering ${label}`);
      } else {
        logger?.log("telegram", `chat ${chatId} busy, queueing ${label}`);
        if (routed.steerError) {
          logger?.log("telegram", `steer failed for chat ${chatId}, queued instead: ${getErrorMessage(routed.steerError)}`);
        }
      }
      if (replaceQueued) chatState.continueAfterClose = true;
      return;
    }

    chatState.processing = true;
    logger?.log("telegram", `processing ${label} in chat ${chatId}`);
    return processChatPromptQueue({ chatId, prompt, label, ctx });
  }

  function processChatPromptQueue({ chatId, prompt, label, ctx = null, beforeInitialPrompt }) {
    const chatState = getChatState(chatId);
    return drainChatPromptQueue({
      chatState,
      initialPrompt: prompt,
      initialCtx: ctx,
      beforeInitialPrompt,
      processPrompt: ({ prompt: currentPrompt, ctx: currentCtx }) => {
        logger?.log("telegram", `prompt dispatch for chat ${chatId}`);
        return processPromptForChat({ chatId, prompt: currentPrompt, ctx: currentCtx });
      },
      onPromptInterrupted: (error) => {
        logger?.log("telegram", `${label} interrupted by queued /new for chat ${chatId}: ${getErrorMessage(error)}`);
      },
      onPromptFailure: async (error) => {
        const message = getErrorMessage(error);
        logger?.error("telegram", `${label} failed for chat ${chatId}: ${message}`);
        await notifyPiAuthIssueIfNeeded(chatId, error);
      }
    });
  }

  async function enqueueOrProcess(ctx) {
    const route = contextRoute(ctx);
    const chatState = getChatState(route.sessionId);

    if (chatState.processing) {
      await ensureQueuedTelegramTyping(chatState, ctx);
      const incomingPrompt = await buildIncomingPrompt(ctx, route);
      const busyMessageMode = typeof ctx.message?.text === "string"
        ? resolveTelegramBusyMessageMode(config, route.sessionId)
        : "queue";
      return enqueuePrompt({
        chatId: route.sessionId,
        prompt: incomingPrompt,
        label: `message ${ctx.msg.message_id}`,
        busyMessageMode,
        ctx
      });
    }

    const incomingPrompt = await buildIncomingPrompt(ctx, route);
    return enqueuePrompt({
      chatId: route.sessionId,
      prompt: incomingPrompt,
      label: `message ${ctx.msg.message_id}`,
      ctx
    });
  }

  async function sendStartupMessages() {
    for (const chatId of config.telegram.authorizedChatIds || []) {
      try {
        logger?.log("telegram", `sending startup message for chat ${chatId}`);
        const chatMeta = config.telegram.chatMeta[chatId] || {};
        await bot.api.sendMessage(chatId, buildStartupMessage(chatMeta));
      } catch (error) {
        logger?.log("telegram", `startup message failed for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      const result = await deliverRestartReceipt((chatId, text, options) => bot.api.sendMessage(chatId, text, options));
      if (result) logger?.log("telegram", `delivered restart receipt ${result.receipt.id}`);
    } catch (error) {
      logger?.log("telegram", `restart receipt delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function scheduleStartupMessages({ skipAgentStartupPrompts = false } = {}) {
    if (skipAgentStartupPrompts) {
      logger?.log("telegram", "skipping startup messages because Pi auth needs attention");
      return;
    }
    const timer = setTimeout(() => {
      sendStartupMessages().catch((error) => {
        logger?.log("telegram", `startup messages failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 0);
    timer.unref?.();
  }

  async function enqueueAsyncPrompt({ chatId, prompt, label, telegramContext }) {
    let ctx = { chat: { id: chatId }, api: bot.api };
    if (telegramContext?.transportChatId && telegramContext?.messageThreadId) {
      ctx = {
        chat: { id: telegramContext.transportChatId, type: "supergroup", is_forum: true },
        from: { id: chatId },
        message: { message_thread_id: telegramContext.messageThreadId },
        api: bot.api
      };
      const route = await resolveTelegramWorkspaceRoute({ config, api: bot.api, ctx });
      if (!route.ok) throw new Error("Scheduled owner-workspace destination is unavailable.");
      workspaceRoutes.set(ctx, route);
    }
    const route = contextRoute(ctx);
    const chatState = getChatState(route.sessionId);
    if (chatState.processing) await ensureQueuedTelegramTyping(chatState, ctx);
    return enqueuePrompt({ chatId: route.sessionId, prompt, label, ctx });
  }

  const { dispatchDueTasks } = createTelegramTaskDispatcher({
    taskStore,
    sendMessage: (chatId, text) => bot.api.sendMessage(chatId, text),
    enqueueAsyncPrompt,
    artifactStore,
    toolRegistry,
    resourceNotes,
    agentManager,
    logger
  });

  async function summarizeSessionBeforeReset(chatId, route = {
    workspace: false,
    sessionId: String(chatId),
    scopeChatId: chatId,
    transportChatId: chatId,
    threadId: null
  }) {
    try {
      const context = await agentManager.getSessionContext(chatId, createTelegramSessionBridge(route), {
        scopeChatId: route.scopeChatId,
        accessGuard: createWorkspaceAccessGuard(route)
      });
      const parentSession = context.session.sessionFile || "";
      if (!context.session.messages.length) return { handoff: "", parentSession: "" };

      const summary = await collectText(context.session, buildSessionHandoffPrompt(), { logger, chatId });
      return { handoff: sanitizeSessionHandoff(summary), parentSession };
    } catch (error) {
      logger?.log("agent", `session handoff summary failed for chat ${chatId}: ${getErrorMessage(error)}`);
      return { handoff: "", parentSession: "" };
    }
  }

  async function handleNewCommand(ctx) {
    const route = contextRoute(ctx);
    const sessionId = route.sessionId;
    const chatState = getChatState(sessionId);
    const wasProcessing = chatState.processing;
    chatState.historyRevision += 1;
    const commandRevision = chatState.historyRevision;
    const prompt = buildNewSessionPrompt(ctx);

    if (wasProcessing) {
      logger?.log("telegram", `chat ${sessionId} busy, queueing new-session command`);
      queueChatPrompt(chatState, prompt, { replace: true, ctx });
      chatState.continueAfterClose = true;
      const reset = (async () => {
        await sessionSeeds.clear(sessionId);
        agentManager.resetSession(sessionId);
      })();
      chatState.beforeNextPrompt = reset;
      try {
        await reset;
      } finally {
        if (chatState.beforeNextPrompt === reset) chatState.beforeNextPrompt = null;
      }
      return;
    }

    chatState.processing = true;
    logger?.log("telegram", `processing new-session command in chat ${sessionId}`);
    await processChatPromptQueue({
      chatId: sessionId,
      prompt,
      label: "new-session command",
      ctx,
      beforeInitialPrompt: async () => {
        const handoff = await withTyping(ctx, () => summarizeSessionBeforeReset(sessionId, route));
        if (chatState.historyRevision !== commandRevision) return;
        if (route.workspace && route.threadId) {
          await sessionSeeds.set(sessionId, handoff.handoff);
        } else {
          await sessionSeeds.clear(sessionId);
        }
        if (chatState.historyRevision !== commandRevision) return;
        agentManager.resetSession(sessionId, handoff);
      }
    });
  }

  bot.catch((error) => {
    logger?.error("telegram", `bot error: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Telegram bot error:", error);
  });

  bot.command("start", async (ctx) => {
    const auth = await authorizeContext(ctx);
    if (!auth.ok) return;
    return ctx.reply(auth.firstTime ? "This chat is now authorized for Arisa." : "Arisa is ready.");
  });

  bot.command("new", async (ctx) => {
    const auth = await authorizeContext(ctx);
    if (!auth.ok) return;
    if (piAuthIssue) {
      await ctx.reply(buildPiAuthRecoveryBlockedMessage({
        config,
        chatId: ctx.chat.id,
        issue: piAuthIssue,
        renewalActive: authRenewals.has(chatKey(ctx.chat.id))
      }));
      return;
    }
    await handleNewCommand(ctx);
  });

  bot.command("restart", handleRestartCommand);

  bot.command("doctor", async (ctx) => {
    const auth = await authorizeContext(ctx);
    if (!auth.ok) return;
    const pending = await ctx.reply(renderTelegramHtml("```text\nRunning Arisa Doctor…\n```"), { parse_mode: "HTML" });
    try {
      await ctx.api.editMessageText(
        ctx.chat.id,
        pending.message_id,
        renderTelegramHtml(formatDoctorReport(await doctor())),
        { parse_mode: "HTML" }
      );
    } catch (error) {
      logger?.error("doctor", `doctor command failed: ${getErrorMessage(error)}`);
      await ctx.api.editMessageText(ctx.chat.id, pending.message_id, `Arisa Doctor failed: ${getErrorMessage(error)}`);
    }
  });

  bot.command("update", async (ctx) => {
    const auth = await authorizeContext(ctx);
    if (!auth.ok) return;
    const pending = await ctx.reply(renderTelegramHtml("```text\nChecking Arisa and official tool updates…\n```"), { parse_mode: "HTML" });
    try {
      const report = await checkUpdates(contextRoute(ctx).scopeChatId);
      const picker = buildUpdatePicker(report);
      await ctx.api.editMessageText(
        ctx.chat.id,
        pending.message_id,
        renderTelegramHtml(formatUpdateReport(report)),
        { parse_mode: "HTML", reply_markup: picker.replyMarkup }
      );
    } catch (error) {
      logger?.error("update", `update check failed: ${getErrorMessage(error)}`);
      await ctx.api.editMessageText(ctx.chat.id, pending.message_id, `Arisa update check failed: ${getErrorMessage(error)}`);
    }
  });

  bot.command("tools", async (ctx) => {
    const auth = await authorizeContext(ctx);
    if (!auth.ok) return;
    await ctx.reply(renderTelegramHtml(formatToolUsageReport(await toolRegistry.usage(contextRoute(ctx).scopeChatId))), { parse_mode: "HTML" });
  });

  bot.command("model", async (ctx) => {
    const auth = await authorizeContext(ctx);
    if (!auth.ok) return;
    await showModelPicker(ctx);
  });

  bot.command("effort", async (ctx) => {
    const auth = await authorizeContext(ctx);
    if (!auth.ok) return;
    await showEffortPicker(ctx);
  });

  bot.command("speed", async (ctx) => {
    const auth = await authorizeContext(ctx);
    if (!auth.ok) return;
    await showSpeedPicker(ctx);
  });

  bot.command("auth", async (ctx) => {
    const auth = await authorizeContext(ctx);
    if (!auth.ok) return;

    const status = getPiAuthStatus(config, ctx.chat.id);
    if (status.hasApiKey || !status.supportsOAuth) {
      await withTyping(ctx, async () => {
        try {
          await agentManager.validateAgent();
          agentManager.clearSessionCache(ctx.chat.id);
          piAuthIssue = null;
          await ctx.reply(buildPiAuthTelegramMessage({ config, chatId: ctx.chat.id, verified: true }));
        } catch (error) {
          const issue = rememberPiAuthIssue(error) || { kind: "validation-failed", message: getErrorMessage(error) };
          piAuthIssue = issue;
          await ctx.reply(buildPiAuthTelegramMessage({ config, chatId: ctx.chat.id, issue }));
        }
      });
      return;
    }

    try {
      const { started } = await startAuthRenewal(ctx.chat.id);
      await ctx.reply(started
        ? "Starting Pi login from Telegram..."
        : "Pi login is already in progress. Paste the redirect URL or code here when you have it.");
    } catch (error) {
      const issue = rememberPiAuthIssue(error) || { kind: "validation-failed", message: getErrorMessage(error) };
      piAuthIssue = issue;
      await ctx.reply(buildPiAuthTelegramMessage({ config, chatId: ctx.chat.id, issue }));
    }
  });

  const handleModelCallback = createTelegramModelCallbackHandler({
    config,
    authorizeContext,
    contextRoute,
    getChatState,
    getProviderModels,
    showModelPicker,
    showEffortPicker,
    persistChatModel,
    persistChatEffort,
    persistChatSpeed,
    logger
  });

  bot.on("callback_query:data", async (ctx, next) => {
    if (await handleUpdateCallback(ctx)) return;
    return handleModelCallback(ctx, next);
  });

  bot.on("message_reaction", async (ctx) => {
    const reaction = ctx.messageReaction;
    const chatId = reaction.chat.id;
    const auth = await authorizeChat({ config, chatId, saveConfig });
    if (!auth.ok || piAuthIssue) return;

    const reactedMessageText = getChatState(chatId).assistantMessages.get(reaction.message_id) || "";
    const prompt = buildReactionPrompt({ reaction, reactedMessageText });
    enqueuePrompt({
      chatId,
      prompt,
      label: `reaction to message ${reaction.message_id}`,
      busyMessageMode: "queue"
    }).catch((error) => {
      getChatState(chatId).processing = false;
      logger?.error("telegram", `reaction handling failed for chat ${chatId}: ${getErrorMessage(error)}`);
    });
  });

  bot.on("message", async (ctx) => {
    const auth = await authorizeContext(ctx);
    if (!auth.ok) return;
    if (!isProcessableTelegramMessage(ctx.message)) return;

    const command = getTelegramCommand(ctx);
    if (command) return;

    if (await submitAuthRenewalInput(ctx)) return;

    if (piAuthIssue) {
      await ctx.reply(buildPiAuthRecoveryBlockedMessage({
        config,
        chatId: ctx.chat.id,
        issue: piAuthIssue,
        renewalActive: authRenewals.has(chatKey(ctx.chat.id))
      }));
      return;
    }

    // grammY long polling awaits each middleware. Keep prompt execution in the background so
    // the next Telegram update can reach the active session as a steer or queued message.
    enqueueOrProcess(ctx).catch(async (error) => {
      const chatState = getChatState(ctx.chat.id);
      chatState.processing = false;
      if (wasPromptErrorNotified(error)) return;
      const issue = getPiAuthIssue(error);
      await ctx.reply(issue
        ? buildPiAuthTelegramMessage({ config, chatId: ctx.chat.id, issue })
        : getErrorMessage(error));
    });
  });

  return {
    async start({ skipAgentStartupPrompts = false } = {}) {
      config.telegram.chatMeta ||= {};
      await bot.api.setMyCommands(telegramCommands);
      if (!taskTimer) {
        taskTimer = setInterval(() => {
          dispatchDueTasks().catch((error) => {
            logger?.error("tasks", `dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }, 1000);
        taskTimer.unref();
      }
      await bot.api.deleteWebhook({ drop_pending_updates: true });
      logger?.log("telegram", "bot polling started");
      scheduleStartupMessages({ skipAgentStartupPrompts });
      await bot.start({ allowed_updates: ["message", "callback_query", "message_reaction"] });
    },

    async stop() {
      if (taskTimer) clearInterval(taskTimer);
      taskTimer = null;
      try {
        bot.stop();
      } catch {}
    },

    async notifyPiAuthIssue(error) {
      let notified = false;
      for (const chatId of config.telegram.authorizedChatIds || []) {
        notified = await notifyPiAuthIssueIfNeeded(chatId, error) || notified;
      }
      return notified;
    }
  };
}
