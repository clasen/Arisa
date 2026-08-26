import { Bot } from "grammy";
import { authorizeChat } from "./auth.js";
import { captureIncomingArtifact } from "./media.js";
import { renderTelegramHtml } from "./text-format.js";
import { buildPiAuthTelegramMessage, getErrorMessage, getPiAuthIssue } from "../../core/agent/auth-flow.js";
import { createTelegramAuthController } from "./telegram-auth-controller.js";
import { resolveChatSpeed } from "../../core/agent/model-selection.js";
import { SessionSeedStore } from "../../core/conversation/session-seed-store.js";
import { formatDoctorReport } from "../../runtime/doctor.js";
import { ToolResourceNoteStore } from "../../core/tools/tool-resource-note-store.js";
import { formatUpdateReport } from "../../runtime/update-manager.js";
import { cancelRestartReceipt, deliverRestartReceipt, prepareRestartReceipt } from "../../runtime/restart-receipt.js";
import { consumeWorkerRecoveryReport, loadWorkerRecoveryReport } from "../../runtime/worker-recovery-report.js";
import { buildUpdatePicker, createTelegramUpdateCallbackHandler } from "./update-command.js";
import { createTelegramModelControls } from "./model-controls.js";
import { createTelegramModelCallbackHandler } from "./model-callback.js";
import { createTelegramTaskDispatcher } from "./task-dispatcher.js";
import { createTelegramSessionBridgeController } from "./telegram-session-bridge.js";
import { createTelegramToolsCommandHandler } from "./telegram-tools-command.js";
import { createTelegramWorkspaceController } from "./telegram-workspace-controller.js";
import { resolveTelegramWorkspaceRoute } from "./workspace-group.js";
import {
  appendGeneralReplyRoutingInstruction,
  isGeneralWorkspaceRoute,
  routeGeneralWorkspaceReply
} from "./reply-topic-routing.js";
import { migrateLegacyReplyTopics, WorkspaceTopicStore } from "./workspace-topic-store.js";
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
  createPromptExecutionReceipt,
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

export function resolveIncomingBusyMessageMode({ config, route, message }) {
  if (route?.workspace) return "queue";
  if (typeof message?.text !== "string") return "queue";
  return resolveTelegramBusyMessageMode(config, route?.sessionId);
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
  const workspaceTopics = new WorkspaceTopicStore();
  const notifiedPromptErrors = new WeakSet();
  let taskTimer = null;
  const { authorizeContext, contextRoute, registerRoute } = createTelegramWorkspaceController({
    config,
    api: bot.api,
    saveConfig
  });

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

  const authController = createTelegramAuthController({
    config,
    api: bot.api,
    agentManager,
    logger,
    markPromptErrorNotified
  });

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
    const prompt = buildPrompt({ ctx, artifact, transcript, toolResult });
    if (!isGeneralWorkspaceRoute(route)) return prompt;
    const [topics, recentProposals] = await Promise.all([
      workspaceTopics.listTopics(route.ownerChatId, route.transportChatId),
      workspaceTopics.listRecentProposals(route.ownerChatId, route.transportChatId)
    ]);
    return appendGeneralReplyRoutingInstruction(prompt, topics, recentProposals);
  }

  const {
    createSessionBridge: createTelegramSessionBridge,
    createWorkspaceAccessGuard,
    installArtifactDeliveryHandler,
    sendTextReply
  } = createTelegramSessionBridgeController({
    config,
    api: bot.api,
    agentManager,
    artifactStore,
    sessionSeeds,
    workspaceTopics,
    getChatState,
    buildTopicInitializationHandoff,
    logger
  });
  installArtifactDeliveryHandler();

  async function processPromptForChat({ chatId, prompt, ctx = null, executionReceipt = null }) {
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
        if (error && typeof error === "object") {
          error.retryable = false;
          error.outcomeUncertain = true;
        }
        throw error;
      } finally {
        if (chatState.activeSession === session) chatState.activeSession = null;
        chatState.activeRoute = null;
      }
      executionReceipt?.resolve({ status: "executed" });
      if (text) {
        const topics = route.workspace && route.ownerChatId
          ? await workspaceTopics.listTopics(route.ownerChatId, route.transportChatId)
          : [];
        const routedReply = routeGeneralWorkspaceReply({ route, text, topics });
        if (routedReply.proposal) {
          await workspaceTopics.recordProposal(route.ownerChatId, route.transportChatId, routedReply.proposal);
          logger?.log("telegram", `recorded topic proposal ${routedReply.proposal} for workspace ${route.transportChatId}`);
        }
        if (!routedReply.text) return;
        const deliveryRoute = routedReply.route;
        const deliveryOptions = (extra = {}) => deliveryRoute.workspace && deliveryRoute.threadId
          ? { ...extra, message_thread_id: deliveryRoute.threadId }
          : extra;
        await createWorkspaceAccessGuard(deliveryRoute)();
        if (routedReply.topic) {
          logger?.log("telegram", `routing General reply to topic ${routedReply.topic.threadId} (${routedReply.topic.name})`);
        }
        await sendTextReply({
          sendText: (message, extra) => bot.api.sendMessage(deliveryRoute.transportChatId, message, deliveryOptions(extra)),
          sendDocument: (file, extra) => bot.api.sendDocument(deliveryRoute.transportChatId, file, deliveryOptions(extra)),
          chatId: sessionId,
          artifactChatId: deliveryRoute.scopeChatId,
          text: routedReply.text
        });
      }
    };

    if (ctx) return withTyping(ctx, work);
    return work();
  }

  async function enqueuePrompt({
    chatId,
    prompt,
    label,
    ctx = null,
    replaceQueued = false,
    busyMessageMode = "queue",
    waitForExecution = false,
    onExecutionStart = null,
    coalesceQueued = false
  }) {
    const chatState = getChatState(chatId);
    const receipt = waitForExecution ? createPromptExecutionReceipt(onExecutionStart) : null;

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
        ctx,
        receipt,
        coalesceQueued
      });
      if (routed.disposition === "steered") {
        logger?.log("telegram", `chat ${chatId} busy, steering ${label}`);
      } else if (routed.disposition === "coalesced") {
        logger?.log("telegram", `chat ${chatId} busy, coalescing ${label} into pending direct turn`);
      } else {
        logger?.log("telegram", `chat ${chatId} busy, queueing ${label}`);
        if (routed.steerError) {
          logger?.log("telegram", `steer failed for chat ${chatId}, queued instead: ${getErrorMessage(routed.steerError)}`);
        }
      }
      if (replaceQueued) chatState.continueAfterClose = true;
      return receipt ? receipt.promise : undefined;
    }

    chatState.processing = true;
    logger?.log("telegram", `processing ${label} in chat ${chatId}`);
    const draining = processChatPromptQueue({ chatId, prompt, label, ctx, initialReceipt: receipt });
    if (!receipt) return draining;
    draining.catch(() => {});
    return receipt.promise;
  }

  function processChatPromptQueue({ chatId, prompt, label, ctx = null, beforeInitialPrompt, initialReceipt = null }) {
    const chatState = getChatState(chatId);
    return drainChatPromptQueue({
      chatState,
      initialPrompt: prompt,
      initialCtx: ctx,
      initialReceipt,
      beforeInitialPrompt,
      processPrompt: ({ prompt: currentPrompt, ctx: currentCtx, receipt }) => {
        logger?.log("telegram", `prompt dispatch for chat ${chatId}`);
        return processPromptForChat({ chatId, prompt: currentPrompt, ctx: currentCtx, executionReceipt: receipt });
      },
      onPromptInterrupted: (error) => {
        logger?.log("telegram", `${label} interrupted by queued /new for chat ${chatId}: ${getErrorMessage(error)}`);
      },
      onPromptFailure: async (error) => {
        const message = getErrorMessage(error);
        logger?.error("telegram", `${label} failed for chat ${chatId}: ${message}`);
        await authController.notifyIssueIfNeeded(chatId, error);
      }
    });
  }

  async function enqueueOrProcess(ctx) {
    const route = contextRoute(ctx);
    const chatState = getChatState(route.sessionId);

    if (chatState.processing) {
      await ensureQueuedTelegramTyping(chatState, ctx);
      const incomingPrompt = await buildIncomingPrompt(ctx, route);
      const busyMessageMode = resolveIncomingBusyMessageMode({
        config,
        route,
        message: ctx.message
      });
      return enqueuePrompt({
        chatId: route.sessionId,
        prompt: incomingPrompt,
        label: `message ${ctx.msg.message_id}`,
        busyMessageMode,
        coalesceQueued: busyMessageMode === "steer" && typeof ctx.message?.text === "string",
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

  async function migrateConfiguredReplyTopics() {
    const migratedGroups = await migrateLegacyReplyTopics(config, workspaceTopics);
    if (!migratedGroups) return;
    await saveConfig(config);
    logger?.log("telegram", `migrated configured reply topics for ${migratedGroups} workspace group(s)`);
  }

  async function sendStartupMessages() {
    let recovery = null;
    try {
      recovery = await loadWorkerRecoveryReport();
    } catch (error) {
      logger?.log("telegram", `worker recovery report load failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let recoveryDelivered = false;
    for (const chatId of config.telegram.authorizedChatIds || []) {
      try {
        logger?.log("telegram", `sending startup message for chat ${chatId}`);
        const chatMeta = config.telegram.chatMeta[chatId] || {};
        await bot.api.sendMessage(chatId, recovery?.text || buildStartupMessage(chatMeta));
        if (recovery) recoveryDelivered = true;
      } catch (error) {
        logger?.log("telegram", `startup message failed for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (recovery && recoveryDelivered) {
      await consumeWorkerRecoveryReport(recovery.report.id).catch((error) => {
        logger?.log("telegram", `worker recovery report cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
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

  async function enqueueAsyncPrompt({ chatId, prompt, label, route: taskRoute, timeoutMs }) {
    let ctx = { chat: { id: chatId }, api: bot.api };
    const destination = taskRoute?.transport === "telegram" ? taskRoute.destination : null;
    if (destination?.chatId && destination?.threadId) {
      ctx = {
        chat: { id: destination.chatId, type: "supergroup", is_forum: true },
        from: { id: chatId },
        message: { message_thread_id: destination.threadId },
        api: bot.api
      };
      const route = await resolveTelegramWorkspaceRoute({ config, api: bot.api, ctx });
      if (!route.ok) throw new Error("Scheduled owner-workspace destination is unavailable.");
      registerRoute(ctx, route);
    }
    const route = contextRoute(ctx);
    const chatState = getChatState(route.sessionId);
    if (chatState.processing) await ensureQueuedTelegramTyping(chatState, ctx);
    let timer = null;
    const execution = enqueuePrompt({
      chatId: route.sessionId,
      prompt,
      label,
      ctx,
      waitForExecution: true,
      onExecutionStart: ({ reject }) => {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
        timer = setTimeout(() => {
          const error = new Error(`${label} exceeded its ${timeoutMs}ms execution deadline`);
          error.retryable = false;
          error.outcomeUncertain = true;
          reject(error);
          agentManager.abortSession(route.sessionId).catch((abortError) => {
            logger?.error("tasks", `${label} abort failed: ${getErrorMessage(abortError)}`);
          });
        }, timeoutMs);
        timer.unref?.();
      }
    });
    execution.then(
      () => { if (timer) clearTimeout(timer); },
      () => { if (timer) clearTimeout(timer); }
    );
    return execution;
  }

  const { dispatchDueTasks } = createTelegramTaskDispatcher({
    taskStore,
    sendMessage: (chatId, text, options) => bot.api.sendMessage(chatId, text, options),
    enqueueAsyncPrompt,
    artifactStore,
    toolRegistry,
    resourceNotes,
    agentManager,
    taskTimeouts: config.tasks,
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
    if (authController.getIssue()) {
      await ctx.reply(authController.buildBlockedMessage(ctx.chat.id));
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

  bot.command("tools", createTelegramToolsCommandHandler({
    authorize: authorizeContext,
    contextRoute,
    toolRegistry,
    withTyping,
    logger
  }));

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

  bot.command("auth", (ctx) => authController.handleCommand(ctx, {
    authorize: authorizeContext,
    withTyping
  }));

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
    if (!auth.ok || authController.getIssue()) return;

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
    await workspaceTopics.observeMessage(contextRoute(ctx), ctx.message).catch((error) => {
      logger?.error("telegram", `workspace topic observation failed: ${getErrorMessage(error)}`);
    });
    if (!isProcessableTelegramMessage(ctx.message)) return;

    const command = getTelegramCommand(ctx);
    if (command) return;

    if (await authController.submitRenewalInput(ctx)) return;

    if (authController.getIssue()) {
      await ctx.reply(authController.buildBlockedMessage(ctx.chat.id));
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
      await migrateConfiguredReplyTopics();
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
        notified = await authController.notifyIssueIfNeeded(chatId, error) || notified;
      }
      return notified;
    }
  };
}
