import { Bot, InputFile, webhookCallback } from "grammy";
import path from "node:path";
import { authorizeChat } from "./auth.js";
import { captureIncomingArtifact } from "./media.js";
import { renderTelegramHtml } from "./text-format.js";
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
  return message?.text || message?.caption || "";
}

function buildPrompt({ ctx, artifact, transcript, toolResult }) {
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
  if (artifact?.path) parts.push(`artifactPath: ${artifact.path}`);
  if (artifact?.id) parts.push(`artifactId: ${artifact.id}`);
  if (artifact?.mimeType) parts.push(`mimeType: ${artifact.mimeType}`);
  if (artifact?.kind) parts.push(`kind: ${artifact.kind}`);
  if (transcript) {
    parts.push(`transcriptArtifactId: ${transcript.id}`);
    parts.push(`transcriptText: ${transcript.text}`);
    parts.push(`Important: the incoming media has already been transcribed. Use the transcript as the user message content. Do not answer with a raw transcription unless the user explicitly asked for one.`);
  }
  if (shouldNormalizeArtifactToText(artifact) && !transcript && toolResult) {
    parts.push(`mediaNormalizationResult: ${JSON.stringify(toolResult)}`);
    parts.push(`Important: pre-reasoning media normalization could not be completed, so you do not have a transcript for this audio/video message.`);
  }

  parts.push(`If you need a CLI tool, use list_tools/tool_help/run_tool.`);
  parts.push(`If a tool config is missing, ask the user naturally and then use set_tool_config.`);
  parts.push(`If the user wants a generated media reply, use send_media_reply.`);
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
  const parts = [
    "Scheduled task fired.",
    `taskId: ${task.id}`,
    `chatId: ${task.payload.chatId}`,
    task.payload.prompt ? `text: ${task.payload.prompt}` : null
  ];

  if (task.payload.artifactId) {
    const chatArtifactStore = artifactStore.forChat(task.payload.chatId);
    const artifact = await chatArtifactStore.get(task.payload.artifactId);
    if (artifact) {
      parts.push(`artifactPath: ${artifact.path || ""}`);
      parts.push(`artifactId: ${artifact.id}`);
      parts.push(`mimeType: ${artifact.mimeType}`);
      parts.push(`kind: ${artifact.kind}`);

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
  parts.push("If needed, use tools.");
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
    "If needed, use tools."
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

async function collectText(session, prompt, { logger, chatId, onSlowPrompt } = {}) {
  let text = "";
  let shouldSeparateAssistantMessage = false;
  let slowPromptTimer = null;
  const unsubscribe = session.subscribe((event) => {
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

  return text.trim();
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

export async function createTelegramBot({ config, artifactStore, toolRegistry, taskStore, agentManager, saveConfig, updateConfig, logger, webhookUrl, setHttpRequestHandler }) {
  const bot = new Bot(config.telegram.token);
  const perChatState = new Map();
  let taskTimer = null;

  function getIncomingChatMeta(ctx) {
    return {
      languageCode: ctx.from?.language_code || "",
      username: ctx.from?.username || "",
      firstName: ctx.from?.first_name || "",
      lastName: ctx.from?.last_name || ""
    };
  }

  function getChatState(chatId) {
    if (!perChatState.has(chatId)) {
      perChatState.set(chatId, { processing: false, nextPrompt: "" });
    }
    return perChatState.get(chatId);
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
      sendMedia: async (filePath, { method = "audio", caption } = {}) => {
        logger?.log("telegram", `sending ${method} reply for chat ${chatId}`);
        const input = new InputFile(filePath);
        if (method === "voice") return bot.api.sendVoice(chatId, input, { caption });
        if (method === "document") return bot.api.sendDocument(chatId, input, { caption });
        return bot.api.sendAudio(chatId, input, { caption });
      }
    };
  }

  async function processPromptForChat({ chatId, prompt, ctx = null }) {
    const work = async () => {
      const { session } = await agentManager.getSessionContext(chatId, createTelegramSessionBridge(chatId));
      let text = "";
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

  async function enqueuePrompt({ chatId, prompt, label, ctx = null }) {
    const chatState = getChatState(chatId);

    if (chatState.processing) {
      logger?.log("telegram", `chat ${chatId} busy, queueing ${label}`);
      chatState.nextPrompt = chatState.nextPrompt
        ? `${chatState.nextPrompt}\n\n${prompt}`
        : prompt;
      return;
    }

    chatState.processing = true;
    logger?.log("telegram", `processing ${label} in chat ${chatId}`);
    let currentPrompt = prompt;
    let currentCtx = ctx;

    try {
      while (currentPrompt) {
        try {
          logger?.log("telegram", `prompt dispatch for chat ${chatId}`);
          await processPromptForChat({ chatId, prompt: currentPrompt, ctx: currentCtx });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger?.error("telegram", `${label} failed for chat ${chatId}: ${message}`);
          throw error;
        } finally {
          currentCtx = null;
        }

        if (chatState.nextPrompt) {
          currentPrompt = chatState.nextPrompt;
          chatState.nextPrompt = "";
        } else {
          currentPrompt = "";
        }
      }
    } finally {
      chatState.processing = false;
    }
  }

  async function enqueueOrProcess(ctx) {
    const chatState = getChatState(ctx.chat.id);

    if (chatState.processing) {
      const incomingPrompt = await buildIncomingPrompt(ctx);
      return enqueuePrompt({
        chatId: ctx.chat.id,
        prompt: incomingPrompt,
        label: `message ${ctx.msg.message_id}`
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

  async function handleNewCommand(ctx) {
    agentManager.resetSession(ctx.chat.id);
    perChatState.set(ctx.chat.id, { processing: false, nextPrompt: "" });
    await enqueuePrompt({
      chatId: ctx.chat.id,
      prompt: buildNewSessionPrompt(ctx),
      label: "new-session command",
      ctx
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
    await handleNewCommand(ctx);
  });

  bot.on("message", async (ctx) => {
    const auth = await authorizeChat({ config, chatId: ctx.chat.id, saveConfig, chatMeta: getIncomingChatMeta(ctx) });
    if (!auth.ok) return;

    const command = getTelegramCommand(ctx);
    if (command) return;

    try {
      await enqueueOrProcess(ctx);
    } catch (error) {
      const chatState = getChatState(ctx.chat.id);
      chatState.processing = false;
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(message);
    }
  });

  return {
    async start() {
      config.telegram.chatMeta ||= {};
      for (const chatId of config.telegram.authorizedChatIds || []) {
        try {
          logger?.log("telegram", `generating startup message for chat ${chatId}`);
          const chatMeta = config.telegram.chatMeta[chatId] || {};
          const welcomePrompt = [
            "System event: Arisa has just started.",
            `chatId: ${chatId}`,
            `preferredTelegramLanguageCode: ${chatMeta.languageCode || "unknown"}`,
            chatMeta.username ? `username: ${chatMeta.username}` : null,
            chatMeta.firstName ? `firstName: ${chatMeta.firstName}` : null,
            "Send a short welcome-back message for Telegram.",
            "Keep it brief, warm, and natural.",
            "Use the user's Telegram language when possible.",
            "Do not mention internal implementation details."
          ].filter(Boolean).join("\n");
          await enqueuePrompt({ chatId, prompt: welcomePrompt, label: "startup message" });
        } catch (error) {
          logger?.log("telegram", `startup message failed for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await bot.api.setMyCommands([
        { command: "new", description: "Start a new chat context" }
      ]);
      if (!taskTimer) {
        taskTimer = setInterval(() => {
          dispatchDueTasks().catch((error) => {
            logger?.error("tasks", `dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }, 1000);
        taskTimer.unref();
      }
      if (webhookUrl && setHttpRequestHandler) {
        const webhookPath = `/telegram-${config.telegram.token.slice(-8)}`;
        const handleUpdate = webhookCallback(bot, "http", {
          timeoutMilliseconds: 60_000,
          onTimeout: "return",
        });
        setHttpRequestHandler((req, res) => {
          const parsed = new URL(req.url, "http://localhost");
          if (req.method === "POST" && parsed.pathname === webhookPath) {
            return handleUpdate(req, res);
          }
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("ok");
        });
        await bot.api.setWebhook(`${webhookUrl}${webhookPath}`);
        logger?.log("telegram", `webhook mode: ${webhookUrl}${webhookPath}`);
      } else {
        logger?.log("telegram", "bot polling started");
        await bot.start({ drop_pending_updates: true });
      }
    },

    async stop() {
      if (taskTimer) clearInterval(taskTimer);
      taskTimer = null;
      try {
        bot.stop();
      } catch {}
    }
  };
}
