import { getErrorMessage } from "../../core/agent/auth-flow.js";
import { resolveChatSpeed } from "../../core/agent/model-selection.js";
import { captureIncomingArtifact } from "./media.js";
import {
  appendGeneralReplyRoutingInstruction,
  isGeneralWorkspaceRoute,
  routeGeneralWorkspaceReply
} from "./reply-topic-routing.js";
import {
  buildNewSessionPrompt,
  buildPrompt,
  buildSessionHandoffPrompt,
  collectText,
  normalizeIncomingArtifact,
  sanitizeSessionHandoff,
  scheduledPromptSpeedOptions,
  withPromptSpeed
} from "./prompt-builders.js";
import {
  createPromptExecutionReceipt,
  drainChatPromptQueue,
  queueChatPrompt,
  routeBusyPrompt
} from "./chat-queue.js";

function directChatRoute(chatId) {
  return {
    workspace: false,
    sessionId: String(chatId),
    scopeChatId: chatId,
    transportChatId: chatId,
    threadId: null
  };
}

export function createTelegramPromptController({
  config,
  api,
  artifactStore,
  toolRegistry,
  agentManager,
  sessionSeeds,
  workspaceTopics,
  logger,
  contextRoute,
  getChatState,
  createTelegramSessionBridge,
  createWorkspaceAccessGuard,
  sendTextReply,
  authController,
  ensureWorkspaceTopicModelSelection,
  ensureQueuedTyping,
  withTyping,
  resolveBusyMessageMode
}) {
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

  async function processPromptForChat({ chatId, prompt, ctx = null, executionReceipt = null }) {
    const route = ctx ? contextRoute(ctx) : directChatRoute(chatId);
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
      const sessionContext = await agentManager.getSessionContext(sessionId, bridge, {
        scopeChatId: route.scopeChatId,
        accessGuard: createWorkspaceAccessGuard(route)
      });
      const { session, speedController } = sessionContext;
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
          onSlowPrompt: () => api.sendMessage(
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
        await sessionContext.release?.();
      }
      executionReceipt?.resolve({ status: "executed" });
      if (!text) return;
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
        sendText: (message, extra) => api.sendMessage(deliveryRoute.transportChatId, message, deliveryOptions(extra)),
        sendDocument: (file, extra) => api.sendDocument(deliveryRoute.transportChatId, file, deliveryOptions(extra)),
        chatId: sessionId,
        artifactChatId: deliveryRoute.scopeChatId,
        text: routedReply.text
      });
    };

    if (ctx) return withTyping(ctx, work);
    return work();
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

  async function enqueueOrProcess(ctx) {
    const route = contextRoute(ctx);
    const chatState = getChatState(route.sessionId);

    if (chatState.processing) {
      await ensureQueuedTyping(chatState, ctx);
      const incomingPrompt = await buildIncomingPrompt(ctx, route);
      const busyMessageMode = resolveBusyMessageMode({
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

  async function summarizeSessionBeforeReset(chatId, route = directChatRoute(chatId)) {
    let context;
    try {
      context = await agentManager.getSessionContext(chatId, createTelegramSessionBridge(route), {
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
    } finally {
      await context?.release?.();
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

  return {
    buildIncomingPrompt,
    enqueueOrProcess,
    enqueuePrompt,
    handleNewCommand,
    processChatPromptQueue,
    processPromptForChat,
    summarizeSessionBeforeReset
  };
}
