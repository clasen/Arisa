import { formatLocationText } from "./media.js";
import { normalizeArtifactForReasoning, shouldNormalizeArtifactToText } from "../../core/artifacts/normalize-for-reasoning.js";

const slowPromptNoticeMs = 300_000;

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

export function getIncomingMessageText(message) {
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

export function buildNewSessionPrompt(ctx) {
  return [
    "System event: /new requested.",
    "Session was reset.",
    `preferredTelegramLanguageCode: ${ctx.from?.language_code || "unknown"}`,
    "Reply with a brief, warm confirmation in the user's language."
  ].join("\n");
}

export function buildStartupMessage(chatMeta = {}) {
  const languageCode = String(chatMeta.languageCode || "").toLowerCase();
  if (languageCode.startsWith("es")) return "Arisa esta en linea de nuevo.";
  if (languageCode.startsWith("pt")) return "Arisa esta online de novo.";
  return "Arisa is back online.";
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

export async function buildAsyncEventPrompt(task, resourceNotes) {
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

export async function normalizeIncomingArtifact({ artifact, toolRegistry, chatArtifactStore, chatId }) {
  const normalizationRequired = Boolean(shouldNormalizeArtifactToText(artifact));
  if (!artifact) return { transcript: null, toolResult: null, normalizationRequired };
  const { normalizedArtifact, toolResult } = await normalizeArtifactForReasoning({
    artifact,
    desiredMimeType: "text/plain",
    toolRegistry,
    chatArtifactStore,
    chatId
  });
  return { transcript: normalizedArtifact, toolResult, normalizationRequired };
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

export function buildSessionHandoffPrompt() {
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

export function sanitizeSessionHandoff(text) {
  const sanitized = String(text || "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[redacted private key]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+)\b/gi, "[redacted credential]")
    .replace(/(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|cookie|secret)\s*[:=]\s*[^\s,;]+/gi, "[redacted credential]")
    .trim();
  if (sanitized.length <= 4000) return sanitized;
  return `${sanitized.slice(0, 3997).trim()}...`;
}
