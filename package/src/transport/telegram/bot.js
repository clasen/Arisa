import { Bot, InputFile } from "grammy";
import path from "node:path";
import { authorizeChat } from "./auth.js";
import { captureIncomingArtifact, formatLocationText } from "./media.js";
import { buildDeviceCodeTelegramMessage } from "./device-code-message.js";
import { buildEffortPicker, buildModelPicker, buildSpeedPicker, parseEffortPickerAction, parseModelPickerAction, parseSpeedPickerAction, reverseModelOrder } from "./model-picker.js";
import { renderTelegramHtml } from "./text-format.js";
import { buildPiAuthRecoveryBlockedMessage, buildPiAuthTelegramMessage, getErrorMessage, getPiAuthIssue, getPiAuthStatus } from "../../core/agent/auth-flow.js";
import { createPiOAuthLogin } from "../../core/agent/pi-auth-login.js";
import { getAgentConfig, resolveChatModel, resolveChatSpeed, resolveChatThinkingLevel, selectChatModel, selectChatSpeed, selectChatThinkingLevel } from "../../core/agent/model-selection.js";
import { clampModelThinkingLevel, createPiRuntime, listModelThinkingLevels, listProviderModels, modelSupportsThinking } from "../../core/agent/pi-runtime.js";
import { clampModelSpeed, MODEL_SPEEDS, modelSupportsSpeed } from "../../core/agent/model-speed.js";
import { normalizeArtifactForReasoning, shouldNormalizeArtifactToText } from "../../core/artifacts/normalize-for-reasoning.js";
import { SessionSeedStore } from "../../core/conversation/session-seed-store.js";
import { formatDoctorReport } from "../../runtime/doctor.js";
import { formatToolUsageReport } from "../../runtime/tool-usage-report.js";
import { ToolResourceNoteStore } from "../../core/tools/tool-resource-note-store.js";
import { formatUpdateReport } from "../../runtime/update-manager.js";
import { cancelRestartReceipt, deliverRestartReceipt, prepareRestartReceipt } from "../../runtime/restart-receipt.js";
import { buildUpdatePicker, createTelegramUpdateCallbackHandler } from "./update-command.js";
import { resolveTelegramWorkspaceRoute, topicSessionId } from "./workspace-group.js";
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

const slowPromptNoticeMs = 300_000;

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

function quotedMessageSummary(message) {
  if (!message) return [];

  const fromName = message.from?.username
    ? `@${message.from.username}`
    : [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || "unknown";

  const parts = [
    `quotedMessageId: ${message.message_id}`,
    `quotedFrom: ${fromName}`
  ];

  if (message.text) parts.push(`quotedText: ${message.text}`);
  if (message.caption) parts.push(`quotedCaption: ${message.caption}`);
  if (message.voice) parts.push(`quotedKind: voice`);
  if (message.audio) parts.push(`quotedKind: audio`);
  if (message.photo?.length) parts.push(`quotedKind: image`);
  if (message.document) parts.push(`quotedKind: document`);
  if (message.video) parts.push(`quotedKind: video`);
  if (message.sticker) parts.push(`quotedKind: sticker`);
  if (message.location) parts.push(`quotedKind: location`, `quotedLocation: ${formatLocationText(message)}`);

  if (!message.text && !message.caption) {
    parts.push(`Important: this message replies to a Telegram message with no textual body available in the update. Use the quoted kind and metadata as context.`);
  }

  return parts;
}

function getTelegramCommand(ctx) {
  const text = ctx.message?.text || "";
  const entity = ctx.message?.entities?.[0];
  if (entity?.type !== "bot_command" || entity.offset !== 0 || !text.startsWith("/")) return "";
  return text.slice(1, entity.length).split("@")[0].trim().toLowerCase();
}

function getIncomingMessageText(message) {
  return message?.text || message?.caption || formatLocationText(message) || "";
}

function telegramDisplayName(entity = {}) {
  if (entity.username) return `@${entity.username}`;
  return [entity.first_name, entity.last_name].filter(Boolean).join(" ") || entity.title || "unknown";
}

function forwardedMessageSummary(message) {
  const origin = message?.forward_origin;
  if (!origin) return [];

  const parts = ["forwarded: true", `forwardedOriginType: ${origin.type}`];
  if (origin.type === "user") parts.push(`forwardedFrom: ${telegramDisplayName(origin.sender_user)}`);
  if (origin.type === "hidden_user") parts.push(`forwardedFrom: ${origin.sender_user_name}`);
  if (origin.type === "chat" || origin.type === "channel") {
    parts.push(`forwardedFrom: ${telegramDisplayName(origin.chat)}`);
  }
  if (origin.type === "channel" && origin.message_id) parts.push(`forwardedMessageId: ${origin.message_id}`);
  if (origin.author_signature) parts.push(`forwardedAuthorSignature: ${origin.author_signature}`);
  if (origin.date) parts.push(`forwardedAt: ${new Date(origin.date * 1000).toISOString()}`);
  return parts;
}

function reactionLabel(reaction = {}) {
  if (reaction.type === "emoji") return reaction.emoji || "emoji";
  if (reaction.type === "custom_emoji") return `custom:${reaction.custom_emoji_id || "unknown"}`;
  if (reaction.type === "paid") return "paid";
  return reaction.type || "unknown";
}

function reactionDifference(left = [], right = []) {
  const remaining = right.map(reactionLabel);
  return left.map(reactionLabel).filter((label) => {
    const index = remaining.indexOf(label);
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}

export function buildReactionPrompt({ reaction, reactedMessageText = "" }) {
  const oldReactions = reaction.old_reaction || [];
  const newReactions = reaction.new_reaction || [];
  const added = reactionDifference(newReactions, oldReactions);
  const removed = reactionDifference(oldReactions, newReactions);
  const actor = reaction.user || reaction.actor_chat || {};
  const actorId = reaction.user?.id || reaction.actor_chat?.id || "unknown";

  return [
    "Incoming Telegram reaction.",
    `chatId: ${reaction.chat.id}`,
    `userId: ${actorId}`,
    `username: ${reaction.user?.username || "(no username)"}`,
    `reactedMessageId: ${reaction.message_id}`,
    reactedMessageText ? `reactedMessageText: ${reactedMessageText}` : null,
    added.length ? `addedReactions: ${added.join(" ")}` : null,
    removed.length ? `removedReactions: ${removed.join(" ")}` : null,
    `currentReactions: ${newReactions.map(reactionLabel).join(" ") || "none"}`,
    `actor: ${telegramDisplayName(actor)}`,
    "Treat this as lightweight feedback on the referenced message. Respond only if the reaction clearly requests action; otherwise stay silent."
  ].filter(Boolean).join("\n");
}

function baseMimeType(mimeType = "") {
  return mimeType.split(";")[0].trim().toLowerCase();
}

function isInlineTextArtifact(artifact, messageText) {
  return artifact?.kind === "text"
    && baseMimeType(artifact.mimeType) === "text/plain"
    && typeof artifact.text === "string"
    && artifact.text === messageText;
}

export function shouldIncludeArtifactReference({ artifact, messageText = "" } = {}) {
  if (!artifact) return false;
  return !isInlineTextArtifact(artifact, messageText);
}

export function buildPrompt({ ctx, artifact, transcript, toolResult }) {
  const parts = [
    `Incoming Telegram message.`,
    `chatId: ${ctx.chat.id}`,
    `userId: ${ctx.from.id}`,
    `username: ${ctx.from.username || "(no username)"}`,
    `messageId: ${ctx.msg.message_id}`
  ];

  const messageText = getIncomingMessageText(ctx.message);
  if (messageText) parts.push(`text: ${messageText}`);
  parts.push(...forwardedMessageSummary(ctx.message));
  parts.push(...quotedMessageSummary(ctx.message?.reply_to_message));
  if (shouldIncludeArtifactReference({ artifact, messageText })) {
    if (artifact?.path) parts.push(`artifactPath: ${artifact.path}`);
    if (artifact?.id) parts.push(`artifactId: ${artifact.id}`);
    if (artifact?.mimeType) parts.push(`mimeType: ${artifact.mimeType}`);
    if (artifact?.kind) parts.push(`kind: ${artifact.kind}`);
  }
  if (transcript) {
    parts.push(`transcriptArtifactId: ${transcript.id}`);
    parts.push(`transcriptText: ${transcript.text}`);
    parts.push(`Important: the incoming media has already been transcribed. Use the transcript as the user message content. Do not answer with a raw transcription unless the user explicitly asked for one.`);
  }
  if (shouldNormalizeArtifactToText(artifact) && !transcript && toolResult) {
    parts.push(`mediaNormalizationResult: ${JSON.stringify(toolResult)}`);
    parts.push(`Important: pre-reasoning media normalization could not be completed, so you do not have a transcript for this audio/video message.`);
  }

  parts.push(`Use read/write/edit for file work in the active workspace, bash for bash-compatible commands, and system_shell for native system commands such as PowerShell on Windows.`);
  parts.push(`If you need an Arisa modular CLI tool, use list_tools/tool_help/run_tool.`);
  parts.push(`If a tool config is missing, ask the user naturally and then use set_tool_config.`);
  parts.push(`To deliver a file to the chat: run_tool with deliver:true to generate and send in one step, or send_artifact with an existing artifactId (e.g. an inbound file).`);
  return parts.join("\n");
}

function buildNewSessionPrompt(ctx) {
  return [
    "System event: /new requested.",
    "Session was reset.",
    `preferredTelegramLanguageCode: ${ctx.from?.language_code || "unknown"}`,
    "Reply with a brief, warm confirmation in the user's language."
  ].join("\n");
}

export function isScheduledTaskPrompt(prompt) {
  return String(prompt || "").startsWith("Scheduled task fired.\n");
}

export async function withPromptSpeed({ speedController, speed, restoreSpeed }, work) {
  if (!speedController || speed === undefined) return work();
  speedController.setSpeed(speed);
  try {
    return await work();
  } finally {
    speedController.setSpeed(restoreSpeed());
  }
}

export async function buildAsyncTaskPrompt({ task, artifactStore, toolRegistry, resourceNotes, logger }) {
  const taskText = task.payload.prompt || "";
  const resourceId = String(task.source?.resourceId || task.payload?.resourceId || "").trim();
  const resourceNote = resourceId && task.source?.toolName
    ? await resourceNotes.get(task.payload.chatId, task.source.toolName, resourceId)
    : "";
  const parts = [
    "Scheduled task fired.",
    `taskId: ${task.id}`,
    `chatId: ${task.payload.chatId}`,
    resourceNote ? `resourceNote: ${resourceNote}` : null,
    taskText ? `text: ${taskText}` : null
  ];

  if (task.payload.artifactId) {
    const chatArtifactStore = artifactStore.forChat(task.payload.chatId);
    const artifact = await chatArtifactStore.get(task.payload.artifactId);
    if (artifact) {
      if (shouldIncludeArtifactReference({ artifact, messageText: taskText })) {
        parts.push(`artifactPath: ${artifact.path || ""}`);
        parts.push(`artifactId: ${artifact.id}`);
        parts.push(`mimeType: ${artifact.mimeType}`);
        parts.push(`kind: ${artifact.kind}`);
      }

      const { normalizedArtifact, toolResult } = await normalizeArtifactForReasoning({
        artifact,
        desiredMimeType: "text/plain",
        toolRegistry,
        chatArtifactStore,
        chatId: task.payload.chatId
      });

      if (normalizedArtifact) {
        logger?.log("tasks", `artifact ${artifact.id} normalized to ${normalizedArtifact.id}`);
        parts.push(`transcriptArtifactId: ${normalizedArtifact.id}`);
        parts.push(`transcriptText: ${normalizedArtifact.text}`);
        parts.push("Important: the attached media artifact has already been normalized for reasoning. Use the transcript as the message content.");
      } else if (shouldNormalizeArtifactToText(artifact) && toolResult) {
        parts.push(`mediaNormalizationResult: ${JSON.stringify(toolResult)}`);
        parts.push("Important: pre-reasoning media normalization could not be completed, so you do not have a transcript for this audio/video artifact.");
      }
    } else {
      parts.push(`artifactId: ${task.payload.artifactId}`);
      parts.push("Important: referenced artifact was not found.");
    }
  }

  parts.push("Treat this as a new request for the chat and fulfill it now.");
  parts.push("If needed, use read/write/edit, bash, system_shell, or Arisa modular tools via run_tool.");
  return parts.filter(Boolean).join("\n");
}

async function buildAsyncEventPrompt(task, resourceNotes) {
  const resourceId = String(task.source?.resourceId || task.payload?.resourceId || "").trim();
  const resourceNote = resourceId && task.source?.toolName
    ? await resourceNotes.get(task.payload.chatId, task.source.toolName, resourceId)
    : "";
  return [
    "External event arrived.",
    `taskId: ${task.id}`,
    `chatId: ${task.payload.chatId}`,
    resourceNote ? `resourceNote: ${resourceNote}` : null,
    task.payload.prompt ? `event: ${task.payload.prompt}` : null,
    "A polling checker detected this external event. Evaluate it and decide the next action.",
    "If it warrants no action, you may stay silent.",
    "If needed, use read/write/edit, bash, system_shell, or Arisa modular tools via run_tool."
  ].filter(Boolean).join("\n");
}

async function normalizeIncomingArtifact({ artifact, toolRegistry, chatArtifactStore, chatId }) {
  if (!artifact) return { transcript: null, toolResult: null };
  const { normalizedArtifact, toolResult } = await normalizeArtifactForReasoning({
    artifact,
    desiredMimeType: "text/plain",
    toolRegistry,
    chatArtifactStore,
    chatId
  });
  return { transcript: normalizedArtifact, toolResult };
}

function sessionEventLogMessage(event) {
  if (event.type === "tool_execution_start") {
    return `tool ${event.toolName} started`;
  }
  if (event.type === "tool_execution_end") {
    return `tool ${event.toolName} ${event.isError ? "failed" : "finished"}`;
  }
  if (event.type === "auto_retry_start") {
    return `auto retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms: ${event.errorMessage}`;
  }
  if (event.type === "auto_retry_end") {
    return event.success
      ? `auto retry succeeded after ${event.attempt} attempt(s)`
      : `auto retry failed after ${event.attempt} attempt(s): ${event.finalError || "unknown error"}`;
  }
  if (event.type === "compaction_start") {
    return `compaction started (${event.reason})`;
  }
  if (event.type === "compaction_end") {
    return `compaction ${event.aborted ? "aborted" : "finished"} (${event.reason})`;
  }
  if (event.type === "message_end" && event.message?.stopReason === "error") {
    return `assistant message ended with error: ${event.message.errorMessage || "unknown error"}`;
  }
  return "";
}

function buildStartupMessage(chatMeta = {}) {
  const languageCode = String(chatMeta.languageCode || "").toLowerCase();
  if (languageCode.startsWith("es")) return "Arisa esta en linea de nuevo.";
  if (languageCode.startsWith("pt")) return "Arisa esta online de novo.";
  return "Arisa is back online.";
}

export async function collectText(session, prompt, { logger, chatId, onSlowPrompt } = {}) {
  const assistantMessages = [];
  let assistantMessage = "";
  let assistantErrorMessage = "";
  let slowPromptTimer = null;
  const finishAssistantMessage = () => {
    if (assistantMessage && !isSilentReply(assistantMessage)) {
      assistantMessages.push(assistantMessage);
    }
    assistantMessage = "";
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.arisaPromptScoped === false) return;
    if (event.type === "message_start" && event.message.role === "assistant") {
      finishAssistantMessage();
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      assistantMessage += event.assistantMessageEvent.delta;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      if (event.message.stopReason === "error") {
        assistantErrorMessage = event.message.errorMessage || "assistant message ended with error";
      } else if (event.message.stopReason !== "aborted") {
        // Auto-compaction and retry can emit a transient error before a successful continuation.
        assistantErrorMessage = "";
      }
      finishAssistantMessage();
    }
    const logMessage = sessionEventLogMessage(event);
    if (logMessage) logger?.log("agent", `chat ${chatId} ${logMessage}`);
  });

  if (onSlowPrompt) {
    slowPromptTimer = setTimeout(() => {
      logger?.log("telegram", `prompt for chat ${chatId} is still running after ${slowPromptNoticeMs}ms`);
      onSlowPrompt().catch((error) => {
        logger?.error("telegram", `slow prompt notice failed for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, slowPromptNoticeMs);
  }

  try {
    await session.prompt(prompt);
  } finally {
    if (slowPromptTimer) clearTimeout(slowPromptTimer);
    unsubscribe();
  }

  if (assistantErrorMessage) {
    throw new Error(assistantErrorMessage);
  }

  finishAssistantMessage();
  return assistantMessages.join("\n\n").trim();
}

export function isSilentReply(text) {
  return /^(?:NO_REPLY|No reply needed\.|No action needed\.)(?:\s+(?:NO_REPLY|No reply needed\.|No action needed\.))*$/.test(String(text || "").trim());
}

function buildSessionHandoffPrompt() {
  return [
    "Prepare a concise handoff for the next Arisa session.",
    "Review the entire active session, including any previous compaction summaries and the latest messages.",
    "Keep only durable context: current goals or projects, decisions, user preferences, unresolved tasks, and important facts needed to continue.",
    "Use at most 8 short bullets and at most 1600 characters.",
    "Exclude secrets, tokens, passwords, cookies, API keys, private file paths, full transcripts, and stale chatter.",
    "Do not take actions, call tools, send messages, or explain the process.",
    "Return only the handoff."
  ].join("\n");
}

function sanitizeSessionHandoff(text) {
  const sanitized = String(text || "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[redacted private key]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+)\b/gi, "[redacted credential]")
    .replace(/(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|cookie|secret)\s*[:=]\s*[^\s,;]+/gi, "[redacted credential]")
    .trim();
  if (sanitized.length <= 4000) return sanitized;
  return `${sanitized.slice(0, 3997).trim()}...`;
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

export async function closeModelPicker(ctx, { messageText, callbackText }) {
  await ctx.api.editMessageText(
    ctx.chat.id,
    ctx.callbackQuery.message.message_id,
    messageText
  );
  await ctx.answerCallbackQuery({ text: callbackText });
}

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

  async function getProviderModels(chatId) {
    const runtime = createPiRuntime({
      provider: config.pi.provider,
      apiKey: config.pi.apiKey
    });
    return reverseModelOrder(listProviderModels(config.pi.provider, runtime));
  }

  async function showModelPicker(ctx, page = 0) {
    const route = contextRoute(ctx);
    const agentConfig = getAgentConfig(config);
    const picker = buildModelPicker({
      provider: agentConfig.provider,
      models: await getProviderModels(route.sessionId),
      selectedModelId: resolveChatModel(config, route.sessionId),
      selectedThinkingLevel: resolveChatThinkingLevel(config, route.sessionId),
      selectedSpeed: resolveChatSpeed(config, route.sessionId),
      page,
      pageSize: config.telegram.modelPickerPageSize
    });
    const extra = { reply_markup: picker.replyMarkup };
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (messageId) {
      return ctx.api.editMessageText(ctx.chat.id, messageId, picker.text, extra);
    }
    return ctx.reply(picker.text, extra);
  }

  async function showEffortPicker(ctx, { model, modelIndex, selectedThinkingLevel } = {}) {
    const route = contextRoute(ctx);
    const agentConfig = getAgentConfig(config);
    const models = await getProviderModels(route.sessionId);
    const resolvedModel = model || models.find((item) => item.id === resolveChatModel(config, route.sessionId));
    if (!resolvedModel) {
      throw new Error(`Model not found for provider ${agentConfig.provider}`);
    }
    if (!modelSupportsThinking(resolvedModel)) {
      const text = `${resolvedModel.provider}/${resolvedModel.id} does not support effort levels.`;
      if (ctx.callbackQuery?.message?.message_id) {
        return ctx.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, text);
      }
      return ctx.reply(text);
    }
    const levels = listModelThinkingLevels(resolvedModel);
    const picker = buildEffortPicker({
      provider: resolvedModel.provider,
      modelId: resolvedModel.id,
      levels,
      selectedThinkingLevel: selectedThinkingLevel
        ?? clampModelThinkingLevel(resolvedModel, resolveChatThinkingLevel(config, route.sessionId)),
      modelIndex
    });
    const extra = { reply_markup: picker.replyMarkup };
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (messageId) {
      return ctx.api.editMessageText(ctx.chat.id, messageId, picker.text, extra);
    }
    return ctx.reply(picker.text, extra);
  }

  async function showSpeedPicker(ctx) {
    const route = contextRoute(ctx);
    const agentConfig = getAgentConfig(config);
    const models = await getProviderModels(route.sessionId);
    const model = models.find((item) => item.id === resolveChatModel(config, route.sessionId));
    if (!model) throw new Error(`Model not found for provider ${agentConfig.provider}`);
    if (!modelSupportsSpeed(model)) {
      const text = `${model.provider}/${model.id} does not support speed 1.5x.`;
      if (ctx.callbackQuery?.message?.message_id) {
        return ctx.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, text);
      }
      return ctx.reply(text);
    }
    const picker = buildSpeedPicker({
      provider: model.provider,
      modelId: model.id,
      speeds: MODEL_SPEEDS,
      selectedSpeed: resolveChatSpeed(config, route.sessionId)
    });
    const extra = { reply_markup: picker.replyMarkup };
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (messageId) return ctx.api.editMessageText(ctx.chat.id, messageId, picker.text, extra);
    return ctx.reply(picker.text, extra);
  }

  async function persistChatModel(chatId, model, thinkingLevel) {
    const agentConfig = getAgentConfig(config);
    const key = chatKey(chatId);
    const hadSelections = Boolean(agentConfig.chatModels);
    const previousSelection = agentConfig.chatModels?.[key];
    const level = clampModelThinkingLevel(model, thinkingLevel ?? resolveChatThinkingLevel(config, chatId));
    const speed = clampModelSpeed(model, resolveChatSpeed(config, chatId));
    selectChatModel(config, chatId, model, { thinkingLevel: level, speed });
    try {
      await saveConfig(config);
    } catch (error) {
      if (previousSelection) {
        agentConfig.chatModels[key] = previousSelection;
      } else {
        delete agentConfig.chatModels[key];
        if (!hadSelections) delete agentConfig.chatModels;
      }
      throw error;
    }
    agentManager.resetSession(chatId);
    return level;
  }

  async function persistChatEffort(chatId, model, thinkingLevel) {
    const agentConfig = getAgentConfig(config);
    const key = chatKey(chatId);
    const hadSelections = Boolean(agentConfig.chatModels);
    const previousSelection = agentConfig.chatModels?.[key];
    const level = clampModelThinkingLevel(model, thinkingLevel);
    selectChatThinkingLevel(config, chatId, level);
    try {
      await saveConfig(config);
    } catch (error) {
      if (previousSelection) {
        agentConfig.chatModels[key] = previousSelection;
      } else {
        delete agentConfig.chatModels[key];
        if (!hadSelections) delete agentConfig.chatModels;
      }
      throw error;
    }
    return level;
  }

  async function persistChatSpeed(chatId, model, speed) {
    const agentConfig = getAgentConfig(config);
    const key = chatKey(chatId);
    const hadSelections = Boolean(agentConfig.chatModels);
    const previousSelection = agentConfig.chatModels?.[key];
    const level = clampModelSpeed(model, speed);
    await agentManager.setModelSpeed(chatId, level);
    selectChatSpeed(config, chatId, level);
    try {
      await saveConfig(config);
    } catch (error) {
      if (previousSelection) {
        agentConfig.chatModels[key] = previousSelection;
      } else {
        delete agentConfig.chatModels[key];
        if (!hadSelections) delete agentConfig.chatModels;
      }
      agentManager.clearSessionCache(chatId);
      throw error;
    }
    return level;
  }

  async function buildIncomingPrompt(ctx, route = contextRoute(ctx)) {
    logger?.log("telegram", `message ${ctx.msg.message_id} in chat ${route.transportChatId} session ${route.sessionId}`);
    const chatArtifactStore = artifactStore.forChat(route.scopeChatId);
    const artifact = await captureIncomingArtifact(ctx, artifactStore, { storageChatId: route.scopeChatId });
    if (artifact) logger?.log("telegram", `captured artifact ${artifact.kind}${artifact.id ? ` ${artifact.id}` : ""}`);
    const { transcript, toolResult } = await normalizeIncomingArtifact({
      artifact,
      toolRegistry,
      chatArtifactStore,
      chatId: route.scopeChatId
    });
    if (transcript) logger?.log("telegram", `media transcribed to artifact ${transcript.id}`);
    if (shouldNormalizeArtifactToText(artifact) && !transcript) {
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
        text = await withPromptSpeed({
          speedController,
          speed: isScheduledTaskPrompt(prompt) ? 1 : undefined,
          restoreSpeed: () => clampModelSpeed(session.model, resolveChatSpeed(config, sessionId))
        }, () => collectText(session, prompt, {
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

  async function dispatchTask(task) {
    const chatId = task.payload?.chatId;
    if (!chatId) {
      await taskStore.fail(task.id, `Task missing chatId: ${task.kind}`);
      return;
    }

    if (task.kind === "agent_task") {
      if (!task.payload.prompt) {
        await taskStore.fail(task.id, "agent_task missing prompt");
        return;
      }
      logger?.log("tasks", `running task ${task.id} for chat ${chatId}`);
      await enqueueAsyncPrompt({
        chatId,
        prompt: await buildAsyncTaskPrompt({ task, artifactStore, toolRegistry, resourceNotes, logger }),
        label: `scheduled task ${task.id}`,
        telegramContext: task.payload.telegramContext
      });
      await taskStore.complete(task.id);
      return;
    }

    if (task.kind === "agent_event") {
      logger?.log("tasks", `agent event ${task.id} for chat ${chatId}`);
      const acknowledgement = String(task.payload?.acknowledgement || "").trim();
      if (acknowledgement) {
        try {
          await bot.api.sendMessage(chatId, acknowledgement);
        } catch (error) {
          logger?.log("telegram", `agent event acknowledgement failed for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await enqueueAsyncPrompt({
        chatId,
        prompt: await buildAsyncEventPrompt(task, resourceNotes),
        label: `agent event ${task.id}`,
        telegramContext: task.payload.telegramContext
      });
      await taskStore.complete(task.id);
      return;
    }

    if (task.kind === "poll_tool") {
      const toolName = task.payload?.toolName;
      if (!toolName) {
        await taskStore.fail(task.id, "poll_tool missing toolName");
        return;
      }
      logger?.log("tasks", `polling tool ${toolName} (task ${task.id}) for chat ${chatId}`);
      try {
        await agentManager.runTool({
          name: toolName,
          request: { args: task.payload.args || {} },
          chatId
        });
      } catch (error) {
        logger?.log("tasks", `poll_tool ${toolName} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await taskStore.complete(task.id);
      return;
    }

    await taskStore.fail(task.id, `Unsupported task: ${task.kind}`);
  }

  async function dispatchDueTasks() {
    const tasks = await taskStore.claimDue(10);
    for (const task of tasks) {
      try {
        await dispatchTask(task);
      } catch (error) {
        await taskStore.fail(task.id, error instanceof Error ? error.message : String(error));
      }
    }
  }

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

  bot.on("callback_query:data", async (ctx, next) => {
    if (await handleUpdateCallback(ctx)) return;
    const modelAction = parseModelPickerAction(ctx.callbackQuery.data);
    const effortAction = modelAction ? null : parseEffortPickerAction(ctx.callbackQuery.data);
    const speedAction = modelAction || effortAction ? null : parseSpeedPickerAction(ctx.callbackQuery.data);
    const action = modelAction || effortAction || speedAction;
    if (!action) return next();
    if (action.type === "noop") {
      await ctx.answerCallbackQuery();
      return;
    }

    const auth = await authorizeContext(ctx);
    if (!auth.ok) {
      await ctx.answerCallbackQuery({ text: "This chat is not authorized.", show_alert: true });
      return;
    }

    try {
      if (action.type === "page") {
        await showModelPicker(ctx, action.value);
        await ctx.answerCallbackQuery();
        return;
      }

      const models = await getProviderModels(ctx.chat.id);
      const chatBusy = getChatState(ctx.chat.id).processing;

      if (action.type === "select") {
        const model = models[action.value];
        if (!model) {
          await ctx.answerCallbackQuery({
            text: "This model list is no longer current. Run /model again.",
            show_alert: true
          });
          return;
        }

        // Reasoning models open the effort picker only — no session reset yet.
        if (modelSupportsThinking(model)) {
          await showEffortPicker(ctx, {
            model,
            modelIndex: action.value,
            selectedThinkingLevel: clampModelThinkingLevel(model, resolveChatThinkingLevel(config, ctx.chat.id))
          });
          await ctx.answerCallbackQuery({ text: `Choose effort for ${model.id}.` });
          return;
        }

        if (chatBusy) {
          await ctx.answerCallbackQuery({
            text: "Wait for the current response before changing models.",
            show_alert: true
          });
          return;
        }

        const currentModelId = resolveChatModel(config, ctx.chat.id);
        const currentEffort = resolveChatThinkingLevel(config, ctx.chat.id);
        if (model.id === currentModelId && currentEffort === "off") {
          await closeModelPicker(ctx, {
            messageText: `Already using ${model.provider}/${model.id}.`,
            callbackText: `Already using ${model.id}.`
          });
          return;
        }

        await persistChatModel(ctx.chat.id, model, "off");
        await ctx.api.editMessageText(
          ctx.chat.id,
          ctx.callbackQuery.message.message_id,
          `Model changed to ${model.provider}/${model.id}.\nA new chat context will start with your next message.`
        );
        await ctx.answerCallbackQuery({ text: `Using ${model.id}.` });
        return;
      }

      if (action.type === "model-effort") {
        const model = models[action.modelIndex];
        if (!model) {
          await ctx.answerCallbackQuery({
            text: "This model list is no longer current. Run /model again.",
            show_alert: true
          });
          return;
        }
        const levels = listModelThinkingLevels(model);
        if (!levels.includes(action.level)) {
          await ctx.answerCallbackQuery({
            text: "That effort level is not available for this model.",
            show_alert: true
          });
          return;
        }

        const currentModelId = resolveChatModel(config, ctx.chat.id);
        const currentEffort = resolveChatThinkingLevel(config, ctx.chat.id);
        if (model.id === currentModelId && action.level === currentEffort) {
          await closeModelPicker(ctx, {
            messageText: `Already using ${model.provider}/${model.id} (effort: ${action.level}).`,
            callbackText: `Already using ${model.id} at ${action.level}.`
          });
          return;
        }

        // Effort-only updates do not reset the session, so they are safe while busy.
        if (model.id === currentModelId) {
          await persistChatEffort(ctx.chat.id, model, action.level);
          await ctx.api.editMessageText(
            ctx.chat.id,
            ctx.callbackQuery.message.message_id,
            `Effort set to ${action.level} for ${model.provider}/${model.id}.`
          );
          await ctx.answerCallbackQuery({ text: `Effort: ${action.level}.` });
          return;
        }

        if (chatBusy) {
          await ctx.answerCallbackQuery({
            text: "Wait for the current response before changing models.",
            show_alert: true
          });
          return;
        }

        await persistChatModel(ctx.chat.id, model, action.level);
        await ctx.api.editMessageText(
          ctx.chat.id,
          ctx.callbackQuery.message.message_id,
          `Model changed to ${model.provider}/${model.id} (effort: ${action.level}).\nA new chat context will start with your next message.`
        );
        await ctx.answerCallbackQuery({ text: `Using ${model.id} / ${action.level}.` });
        return;
      }

      if (action.type === "effort") {
        const model = models.find((item) => item.id === resolveChatModel(config, ctx.chat.id));
        if (!model) {
          await ctx.answerCallbackQuery({
            text: "Current model is unavailable. Run /model again.",
            show_alert: true
          });
          return;
        }
        if (!modelSupportsThinking(model)) {
          await ctx.answerCallbackQuery({
            text: "This model does not support effort levels.",
            show_alert: true
          });
          return;
        }
        const levels = listModelThinkingLevels(model);
        if (!levels.includes(action.level)) {
          await ctx.answerCallbackQuery({
            text: "That effort level is not available for this model.",
            show_alert: true
          });
          return;
        }
        const currentEffort = resolveChatThinkingLevel(config, ctx.chat.id);
        if (action.level === currentEffort) {
          await closeModelPicker(ctx, {
            messageText: `Already using effort ${action.level} for ${model.provider}/${model.id}.`,
            callbackText: `Already using effort ${action.level}.`
          });
          return;
        }
        await persistChatEffort(ctx.chat.id, model, action.level);
        await ctx.api.editMessageText(
          ctx.chat.id,
          ctx.callbackQuery.message.message_id,
          `Effort set to ${action.level} for ${model.provider}/${model.id}.`
        );
        await ctx.answerCallbackQuery({ text: `Effort: ${action.level}.` });
        return;
      }

      if (action.type === "speed") {
        const model = models.find((item) => item.id === resolveChatModel(config, ctx.chat.id));
        if (!model) {
          await ctx.answerCallbackQuery({
            text: "Current model is unavailable. Run /model again.",
            show_alert: true
          });
          return;
        }
        if (!modelSupportsSpeed(model)) {
          await ctx.answerCallbackQuery({
            text: "This model does not support speed 1.5x.",
            show_alert: true
          });
          return;
        }
        const currentSpeed = resolveChatSpeed(config, ctx.chat.id);
        if (action.speed === currentSpeed) {
          await closeModelPicker(ctx, {
            messageText: `Already using speed ${action.speed.toFixed(1)}x for ${model.provider}/${model.id}.`,
            callbackText: `Already using speed ${action.speed.toFixed(1)}x.`
          });
          return;
        }
        await persistChatSpeed(ctx.chat.id, model, action.speed);
        await ctx.api.editMessageText(
          ctx.chat.id,
          ctx.callbackQuery.message.message_id,
          `Speed set to ${action.speed.toFixed(1)}x for ${model.provider}/${model.id}.`
        );
        await ctx.answerCallbackQuery({ text: `Speed: ${action.speed.toFixed(1)}x.` });
      }
    } catch (error) {
      logger?.error("telegram", `model selection failed for chat ${ctx.chat.id}: ${getErrorMessage(error)}`);
      await ctx.answerCallbackQuery({
        text: "Could not change the model, effort, or speed.",
        show_alert: true
      }).catch(() => {});
    }
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
