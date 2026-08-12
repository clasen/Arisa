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
import { formatPortableSessionHistory } from "../../core/agent/agent-manager.js";
import { ConversationHistoryStore } from "../../core/conversation/conversation-history-store.js";
import { formatDoctorReport } from "../../runtime/doctor.js";

const slowPromptNoticeMs = 300_000;

export const telegramCommands = Object.freeze([
  { command: "new", description: "Start a new chat context" },
  { command: "restart", description: "Restart the Arisa service" },
  { command: "doctor", description: "Check and repair Arisa runtime health" },
  { command: "update", description: "Check Arisa and official tool updates" },
  { command: "model", description: "Choose the model for this chat" },
  { command: "effort", description: "Choose reasoning effort for this chat" },
  { command: "speed", description: "Choose model speed for this chat" },
  { command: "auth", description: "Show authentication status" }
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
      const handoff = await requestRestart();
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

async function buildAsyncTaskPrompt({ task, artifactStore, toolRegistry, logger }) {
  const taskText = task.payload.prompt || "";
  const parts = [
    "Scheduled task fired.",
    `taskId: ${task.id}`,
    `chatId: ${task.payload.chatId}`,
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

function buildAsyncEventPrompt(task) {
  return [
    "External event arrived.",
    `taskId: ${task.id}`,
    `chatId: ${task.payload.chatId}`,
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
  let text = "";
  let assistantErrorMessage = "";
  let shouldSeparateAssistantMessage = false;
  let slowPromptTimer = null;
  const unsubscribe = session.subscribe((event) => {
    if (event.arisaPromptScoped === false) return;
    if (event.type === "message_start" && event.message.role === "assistant") {
      shouldSeparateAssistantMessage = text.trim().length > 0;
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (shouldSeparateAssistantMessage && event.assistantMessageEvent.delta) {
        text += "\n\n";
        shouldSeparateAssistantMessage = false;
      }
      text += event.assistantMessageEvent.delta;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      if (event.message.stopReason === "error") {
        assistantErrorMessage = event.message.errorMessage || "assistant message ended with error";
      } else if (event.message.stopReason !== "aborted") {
        // Auto-compaction and retry can emit a transient error before a successful continuation.
        assistantErrorMessage = "";
      }
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

  return text.trim();
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

async function withTyping(ctx, work) {
  await ctx.api.sendChatAction(ctx.chat.id, "typing");
  const timer = setInterval(() => {
    ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  }, 4000);

  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

export function createChatStateStore() {
  const states = new Map();

  function reset(chatId) {
    const state = {
      processing: false,
      pendingPrompts: [],
      continueAfterClose: false,
      historyRevision: 0,
      beforeNextPrompt: null,
      activeSession: null,
      activeSteers: []
    };
    states.set(String(chatId), state);
    return state;
  }

  return {
    get(chatId) {
      const key = String(chatId);
      return states.get(key) || reset(key);
    },
    reset,
    anyProcessing() {
      return [...states.values()].some((state) => state.processing);
    }
  };
}

export function queueChatPrompt(chatState, prompt, { replace = false } = {}) {
  if (replace) chatState.pendingPrompts = [];
  chatState.pendingPrompts.push(prompt);
}

function takeQueuedPrompt(chatState) {
  return chatState.pendingPrompts.shift() || "";
}

export function resolveTelegramBusyMessageMode(config, chatId) {
  const chatMode = config.telegram?.chatMeta?.[String(chatId)]?.busyMessageMode;
  const mode = chatMode || config.telegram?.busyMessageMode;
  return mode === "steer" ? "steer" : "queue";
}

export async function routeBusyPrompt({ chatState, prompt, mode = "queue", replaceQueued = false }) {
  const session = chatState.activeSession;
  if (
    mode === "steer"
    && !replaceQueued
    && !chatState.continueAfterClose
    && !chatState.beforeNextPrompt
    && session?.isStreaming
    && typeof session.steer === "function"
  ) {
    try {
      await session.steer(prompt);
      chatState.activeSteers.push(prompt);
      return { disposition: "steered" };
    } catch (error) {
      queueChatPrompt(chatState, prompt);
      return { disposition: "queued", steerError: error };
    }
  }

  queueChatPrompt(chatState, prompt, { replace: replaceQueued });
  return { disposition: "queued" };
}

export async function drainChatPromptQueue({
  chatState,
  initialPrompt,
  initialCtx = null,
  processPrompt,
  onPromptFailure,
  onPromptInterrupted,
  beforeInitialPrompt
}) {
  let currentPrompt = initialPrompt;
  let currentCtx = initialCtx;

  try {
    await beforeInitialPrompt?.();
    while (currentPrompt) {
      while (chatState.beforeNextPrompt) {
        const gate = chatState.beforeNextPrompt;
        await gate;
        if (chatState.beforeNextPrompt === gate) chatState.beforeNextPrompt = null;
      }
      if (chatState.continueAfterClose && chatState.pendingPrompts.length) {
        currentPrompt = takeQueuedPrompt(chatState);
        chatState.continueAfterClose = false;
        currentCtx = null;
      }
      try {
        await processPrompt({ prompt: currentPrompt, ctx: currentCtx });
      } catch (error) {
        if (chatState.continueAfterClose && chatState.pendingPrompts.length) {
          await onPromptInterrupted?.(error);
        } else {
          await onPromptFailure?.(error);
          throw error;
        }
      } finally {
        currentCtx = null;
      }

      currentPrompt = takeQueuedPrompt(chatState);
      chatState.continueAfterClose = false;
    }
  } finally {
    chatState.processing = false;
    chatState.activeSession = null;
    chatState.activeSteers = [];
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

export async function createTelegramBot({ config, artifactStore, toolRegistry, taskStore, agentManager, saveConfig, updateConfig, doctor, checkUpdates, requestRestart, logger }) {
  const bot = new Bot(config.telegram.token);
  const perChatState = createChatStateStore();
  const conversationHistory = new ConversationHistoryStore();
  const notifiedPromptErrors = new WeakSet();
  const authRenewals = new Map();
  let piAuthIssue = null;
  let taskTimer = null;

  const handleRestartCommand = createTelegramRestartHandler({
    authorize: (ctx) => authorizeChat({
      config,
      chatId: ctx.chat.id,
      saveConfig,
      chatMeta: getIncomingChatMeta(ctx)
    }),
    requestRestart,
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
    const agentConfig = getAgentConfig(config);
    const picker = buildModelPicker({
      provider: agentConfig.provider,
      models: await getProviderModels(ctx.chat.id),
      selectedModelId: resolveChatModel(config, ctx.chat.id),
      selectedThinkingLevel: resolveChatThinkingLevel(config, ctx.chat.id),
      selectedSpeed: resolveChatSpeed(config, ctx.chat.id),
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
    const agentConfig = getAgentConfig(config);
    const models = await getProviderModels(ctx.chat.id);
    const resolvedModel = model || models.find((item) => item.id === resolveChatModel(config, ctx.chat.id));
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
        ?? clampModelThinkingLevel(resolvedModel, resolveChatThinkingLevel(config, ctx.chat.id)),
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
    const agentConfig = getAgentConfig(config);
    const models = await getProviderModels(ctx.chat.id);
    const model = models.find((item) => item.id === resolveChatModel(config, ctx.chat.id));
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
      selectedSpeed: resolveChatSpeed(config, ctx.chat.id)
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

  async function buildIncomingPrompt(ctx) {
    const chatId = ctx.chat.id;
    logger?.log("telegram", `message ${ctx.msg.message_id} in chat ${chatId}`);
    const chatArtifactStore = artifactStore.forChat(chatId);
    const artifact = await captureIncomingArtifact(ctx, artifactStore);
    if (artifact) logger?.log("telegram", `captured artifact ${artifact.kind}${artifact.id ? ` ${artifact.id}` : ""}`);
    const { transcript, toolResult } = await normalizeIncomingArtifact({ artifact, toolRegistry, chatArtifactStore, chatId });
    if (transcript) logger?.log("telegram", `media transcribed to artifact ${transcript.id}`);
    if (shouldNormalizeArtifactToText(artifact) && !transcript) {
      logger?.log("telegram", `media normalization unavailable for chat ${ctx.chat.id}: ${toolResult?.error || toolResult?.missingConfig?.join(", ") || "unknown error"}`);
    }
    return buildPrompt({ ctx, artifact, transcript, toolResult });
  }

  async function sendTextReply({ sendText, sendDocument, chatId, text }) {
    const maxInlineReplyLength = 3500;

    if (isSilentReply(text)) {
      logger?.log("telegram", `suppressing silent reply for chat ${chatId}`);
      return;
    }

    if (text.length > maxInlineReplyLength) {
      logger?.log("telegram", `sending long reply as markdown attachment for chat ${chatId}`);
      const chatArtifactStore = artifactStore.forChat(chatId);
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
    await sendText(renderTelegramHtml(text), { parse_mode: "HTML" });
  }

  function createTelegramSessionBridge(chatId) {
    return {
      sendMedia: async (filePath, { method = "audio", caption, filename } = {}) => {
        logger?.log("telegram", `sending ${method} reply for chat ${chatId}`);
        const input = new InputFile(filePath, filename || undefined);
        if (method === "voice") return bot.api.sendVoice(chatId, input, { caption });
        if (method === "document") return bot.api.sendDocument(chatId, input, { caption });
        if (method === "photo" || method === "image") return bot.api.sendPhoto(chatId, input, { caption });
        if (method === "video") return bot.api.sendVideo(chatId, input, { caption });
        return bot.api.sendAudio(chatId, input, { caption });
      }
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
    await createTelegramSessionBridge(chatId).sendMedia(artifact.path, {
      method: resolvedMethod,
      caption: safeCaption,
      filename: path.basename(artifact.path)
    });
    return { ok: true, artifactId: artifact.id, method: resolvedMethod };
  });

  async function processPromptForChat({ chatId, prompt, ctx = null }) {
    const work = async () => {
      const { session } = await agentManager.getSessionContext(chatId, createTelegramSessionBridge(chatId));
      const historyRevision = getChatState(chatId).historyRevision;
      await conversationHistory.ensureSeed(chatId, {
        runtime: "pi",
        history: formatPortableSessionHistory(session.messages)
      });
      let text = "";
      let steeredPrompts = [];
      const chatState = getChatState(chatId);
      chatState.activeSession = session;
      chatState.activeSteers = [];
      try {
        text = await collectText(session, prompt, {
          logger,
          chatId,
          onSlowPrompt: () => bot.api.sendMessage(
            chatId,
            "This is taking longer than 5 minutes, so I will keep the current session running instead of starting over. Send /new if you want to abandon it and start fresh."
          )
        });
      } catch (error) {
        agentManager.resetSession(chatId);
        throw error;
      } finally {
        steeredPrompts = [...chatState.activeSteers];
        if (chatState.activeSession === session) chatState.activeSession = null;
        chatState.activeSteers = [];
      }
      if (getChatState(chatId).historyRevision === historyRevision) {
        const historyPrompt = steeredPrompts.length
          ? [prompt, ...steeredPrompts.map((message) => `[Steering message]\n${message}`)].join("\n\n")
          : prompt;
        await conversationHistory.appendTurn(chatId, {
          runtime: "pi",
          prompt: historyPrompt,
          response: text
        });
      }
      if (text) {
        await sendTextReply({
          sendText: (message, extra) => bot.api.sendMessage(chatId, message, extra),
          sendDocument: (file, extra) => bot.api.sendDocument(chatId, file, extra),
          chatId,
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
      const routed = await routeBusyPrompt({
        chatState,
        prompt,
        mode: busyMessageMode,
        replaceQueued
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
    const chatState = getChatState(ctx.chat.id);

    if (chatState.processing) {
      const incomingPrompt = await buildIncomingPrompt(ctx);
      const busyMessageMode = typeof ctx.message?.text === "string"
        ? resolveTelegramBusyMessageMode(config, ctx.chat.id)
        : "queue";
      return enqueuePrompt({
        chatId: ctx.chat.id,
        prompt: incomingPrompt,
        label: `message ${ctx.msg.message_id}`,
        busyMessageMode
      });
    }

    const incomingPrompt = await buildIncomingPrompt(ctx);
    return enqueuePrompt({
      chatId: ctx.chat.id,
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
      await enqueuePrompt({
        chatId,
        prompt: await buildAsyncTaskPrompt({ task, artifactStore, toolRegistry, logger }),
        label: `scheduled task ${task.id}`
      });
      await taskStore.complete(task.id);
      return;
    }

    if (task.kind === "agent_event") {
      logger?.log("tasks", `agent event ${task.id} for chat ${chatId}`);
      await enqueuePrompt({
        chatId,
        prompt: buildAsyncEventPrompt(task),
        label: `agent event ${task.id}`
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

  async function summarizeSessionBeforeReset(chatId) {
    try {
      const context = await agentManager.getSessionContext(chatId, createTelegramSessionBridge(chatId));
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
    const chatState = getChatState(ctx.chat.id);
    const wasProcessing = chatState.processing;
    chatState.historyRevision += 1;
    const commandRevision = chatState.historyRevision;
    const prompt = buildNewSessionPrompt(ctx);

    if (wasProcessing) {
      logger?.log("telegram", `chat ${ctx.chat.id} busy, queueing new-session command`);
      queueChatPrompt(chatState, prompt, { replace: true });
      chatState.continueAfterClose = true;
      const reset = (async () => {
        await conversationHistory.reset(ctx.chat.id, { runtime: "pi" });
        agentManager.resetSession(ctx.chat.id);
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
    logger?.log("telegram", `processing new-session command in chat ${ctx.chat.id}`);
    await processChatPromptQueue({
      chatId: ctx.chat.id,
      prompt,
      label: "new-session command",
      ctx,
      beforeInitialPrompt: async () => {
        const handoff = await withTyping(ctx, () => summarizeSessionBeforeReset(ctx.chat.id));
        if (chatState.historyRevision !== commandRevision) return;
        await conversationHistory.reset(ctx.chat.id, {
          runtime: "pi",
          history: handoff.handoff
        });
        if (chatState.historyRevision !== commandRevision) return;
        agentManager.resetSession(ctx.chat.id, handoff);
      }
    });
  }

  bot.catch((error) => {
    logger?.error("telegram", `bot error: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Telegram bot error:", error);
  });

  bot.command("start", async (ctx) => {
    const auth = await authorizeChat({ config, chatId: ctx.chat.id, saveConfig, chatMeta: getIncomingChatMeta(ctx) });
    if (!auth.ok) return;
    return ctx.reply(auth.firstTime ? "This chat is now authorized for Arisa." : "Arisa is ready.");
  });

  bot.command("new", async (ctx) => {
    const auth = await authorizeChat({ config, chatId: ctx.chat.id, saveConfig, chatMeta: getIncomingChatMeta(ctx) });
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
    const auth = await authorizeChat({ config, chatId: ctx.chat.id, saveConfig, chatMeta: getIncomingChatMeta(ctx) });
    if (!auth.ok) return;
    await withTyping(ctx, async () => {
      try {
        await ctx.reply(formatDoctorReport(await doctor()));
      } catch (error) {
        logger?.error("doctor", `doctor command failed: ${getErrorMessage(error)}`);
        await ctx.reply(`Arisa Doctor failed: ${getErrorMessage(error)}`);
      }
    });
  });

  bot.command("update", async (ctx) => {
    const auth = await authorizeChat({ config, chatId: ctx.chat.id, saveConfig, chatMeta: getIncomingChatMeta(ctx) });
    if (!auth.ok) return;
    await ctx.reply("Checking Arisa and official tool updates…");
    try {
      await ctx.reply(renderTelegramHtml(await checkUpdates(ctx.chat.id)), { parse_mode: "HTML" });
    } catch (error) {
      logger?.error("update", `update check failed: ${getErrorMessage(error)}`);
      await ctx.reply(`Arisa update check failed: ${getErrorMessage(error)}`);
    }
  });

  bot.command("model", async (ctx) => {
    const auth = await authorizeChat({ config, chatId: ctx.chat.id, saveConfig, chatMeta: getIncomingChatMeta(ctx) });
    if (!auth.ok) return;
    await showModelPicker(ctx);
  });

  bot.command("effort", async (ctx) => {
    const auth = await authorizeChat({ config, chatId: ctx.chat.id, saveConfig, chatMeta: getIncomingChatMeta(ctx) });
    if (!auth.ok) return;
    await showEffortPicker(ctx);
  });

  bot.command("speed", async (ctx) => {
    const auth = await authorizeChat({ config, chatId: ctx.chat.id, saveConfig, chatMeta: getIncomingChatMeta(ctx) });
    if (!auth.ok) return;
    await showSpeedPicker(ctx);
  });

  bot.command("auth", async (ctx) => {
    const auth = await authorizeChat({ config, chatId: ctx.chat.id, saveConfig, chatMeta: getIncomingChatMeta(ctx) });
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
    const modelAction = parseModelPickerAction(ctx.callbackQuery.data);
    const effortAction = modelAction ? null : parseEffortPickerAction(ctx.callbackQuery.data);
    const speedAction = modelAction || effortAction ? null : parseSpeedPickerAction(ctx.callbackQuery.data);
    const action = modelAction || effortAction || speedAction;
    if (!action) return next();
    if (action.type === "noop") {
      await ctx.answerCallbackQuery();
      return;
    }

    const auth = await authorizeChat({ config, chatId: ctx.chat.id, saveConfig });
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

  bot.on("message", async (ctx) => {
    const auth = await authorizeChat({ config, chatId: ctx.chat.id, saveConfig, chatMeta: getIncomingChatMeta(ctx) });
    if (!auth.ok) return;

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
      await bot.start();
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
