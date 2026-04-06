import { Bot, InputFile } from "grammy";
import { authorizeChat } from "./auth.js";
import { captureIncomingArtifact } from "./media.js";
import { renderTelegramHtml, splitTelegramText } from "./text-format.js";

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

function buildPrompt({ ctx, artifact, transcript }) {
  const parts = [
    `New Telegram message.`,
    `chatId: ${ctx.chat.id}`,
    `userId: ${ctx.from.id}`,
    `username: ${ctx.from.username || "(no username)"}`,
    `messageId: ${ctx.msg.message_id}`
  ];

  if (ctx.message?.text) parts.push(`text: ${ctx.message.text}`);
  parts.push(...quotedMessageSummary(ctx.message?.reply_to_message));
  if (artifact?.path) parts.push(`artifactPath: ${artifact.path}`);
  if (artifact?.id) parts.push(`artifactId: ${artifact.id}`);
  if (artifact?.mimeType) parts.push(`mimeType: ${artifact.mimeType}`);
  if (artifact?.kind) parts.push(`kind: ${artifact.kind}`);
  if (transcript) {
    parts.push(`transcriptArtifactId: ${transcript.id}`);
    parts.push(`transcriptText: ${transcript.text}`);
    parts.push(`Important: the incoming audio has already been transcribed. Use the transcript as the user message content. Do not answer with a raw transcription unless the user explicitly asked for one.`);
  }

  parts.push(`If you need a CLI tool, use list_tools/tool_help/run_tool.`);
  parts.push(`If a tool config is missing, ask the user naturally and then use set_tool_config.`);
  parts.push(`If the user wants a generated media reply, use send_media_reply.`);
  return parts.join("\n");
}

async function maybeTranscribeIncomingAudio({ artifact, toolRegistry, artifactStore }) {
  if (!artifact || artifact.kind !== "audio") return { transcript: null };

  const result = await toolRegistry.run({
    name: "openai-transcribe",
    request: {
      artifact,
      args: {}
    }
  });

  if (!result.ok) {
    return { transcript: null, toolResult: result };
  }

  if (!result.output?.text) {
    return { transcript: null, toolResult: { ok: false, error: "Transcription returned no text." } };
  }

  const transcript = await artifactStore.createText({
    text: result.output.text,
    source: { type: "tool", toolName: "openai-transcribe" },
    metadata: { fromArtifactId: artifact.id, tool: "openai-transcribe" }
  });

  return { transcript, toolResult: result };
}

async function collectText(session, prompt) {
  let text = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  await session.prompt(prompt);
  unsubscribe();
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

export async function createTelegramBot({ config, artifactStore, toolRegistry, agentManager, saveConfig, updateConfig, logger }) {
  const bot = new Bot(config.telegram.apiKey);
  const perChatState = new Map();

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
    logger?.log("telegram", `message ${ctx.msg.message_id} in chat ${ctx.chat.id}`);
    const artifact = await captureIncomingArtifact(ctx, artifactStore);
    if (artifact) logger?.log("telegram", `captured artifact ${artifact.kind}${artifact.id ? ` ${artifact.id}` : ""}`);
    const { transcript, toolResult } = await maybeTranscribeIncomingAudio({ artifact, toolRegistry, artifactStore });
    if (transcript) logger?.log("telegram", `audio transcribed to artifact ${transcript.id}`);
    if (artifact?.kind === "audio" && !transcript) {
      if (toolResult?.missingConfig?.includes("OPENAI_API_KEY")) {
        throw new Error("I need the OpenAI API key for ~/.arisa/tools/openai-transcribe/config.js before I can transcribe incoming audio.");
      }
      throw new Error(toolResult?.error || "Audio transcription failed.");
    }
    return buildPrompt({ ctx, artifact, transcript });
  }

  async function sendTextReply(send, chatId, text) {
    logger?.log("telegram", `sending text reply for chat ${chatId}`);
    for (const chunk of splitTelegramText(text)) {
      await send(renderTelegramHtml(chunk), { parse_mode: "HTML" });
    }
  }

  async function processPrompt(ctx, prompt) {
    const telegram = {
      sendMedia: async (filePath, { method = "audio", caption } = {}) => {
        logger?.log("telegram", `sending ${method} reply for chat ${ctx.chat.id}`);
        const input = new InputFile(filePath);
        if (method === "voice") return ctx.replyWithVoice(input, { caption });
        if (method === "document") return ctx.replyWithDocument(input, { caption });
        return ctx.replyWithAudio(input, { caption });
      }
    };
    return withTyping(ctx, async () => {
      const { session } = await agentManager.getSessionContext(ctx.chat.id, telegram);
      const text = await collectText(session, prompt);
      if (text) {
        await sendTextReply((message, extra) => ctx.reply(message, extra), ctx.chat.id, text);
      }
    });
  }

  async function enqueueOrProcess(ctx) {
    const chatState = getChatState(ctx.chat.id);
    const incomingPrompt = await buildIncomingPrompt(ctx);

    if (chatState.processing) {
      logger?.log("telegram", `chat ${ctx.chat.id} busy, queueing message ${ctx.msg.message_id}`);
      chatState.nextPrompt = chatState.nextPrompt
        ? `${chatState.nextPrompt}\n\n${incomingPrompt}`
        : incomingPrompt;
      return ctx.reply("Queued. I will process this right after the current task finishes.");
    }

    chatState.processing = true;
    logger?.log("telegram", `processing message ${ctx.msg.message_id} in chat ${ctx.chat.id}`);
    let currentPrompt = incomingPrompt;

    while (currentPrompt) {
      try {
        logger?.log("telegram", `prompt dispatch for chat ${ctx.chat.id}`);
        await processPrompt(ctx, currentPrompt);
      } finally {
        if (chatState.nextPrompt) {
          currentPrompt = chatState.nextPrompt;
          chatState.nextPrompt = "";
        } else {
          currentPrompt = "";
        }
      }
    }

    chatState.processing = false;
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

  bot.on("message", async (ctx) => {
    const auth = await authorizeChat({ config, chatId: ctx.chat.id, saveConfig, chatMeta: getIncomingChatMeta(ctx) });
    if (!auth.ok) return;

    try {
      await enqueueOrProcess(ctx);
    } catch (error) {
      const chatState = getChatState(ctx.chat.id);
      chatState.processing = false;
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Error: ${message}`);
    }
  });

  return {
    async start() {
      config.telegram.chatMeta ||= {};
      for (const chatId of config.telegram.authorizedChatIds || []) {
        try {
          logger?.log("telegram", `generating startup message for chat ${chatId}`);
          const chatMeta = config.telegram.chatMeta[chatId] || {};
          const telegram = {
            sendMedia: async (filePath, { method = "audio", caption } = {}) => {
              logger?.log("telegram", `sending ${method} reply for chat ${chatId}`);
              const input = new InputFile(filePath);
              if (method === "voice") return bot.api.sendVoice(chatId, input, { caption });
              if (method === "document") return bot.api.sendDocument(chatId, input, { caption });
              return bot.api.sendAudio(chatId, input, { caption });
            }
          };
          const { session } = await agentManager.getSessionContext(chatId, telegram);
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
          const text = await collectText(session, welcomePrompt);
          if (text) {
            await sendTextReply((message, extra) => bot.api.sendMessage(chatId, message, extra), chatId, text);
          }
        } catch (error) {
          logger?.log("telegram", `startup message failed for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      logger?.log("telegram", "bot polling started");
      await bot.start();
    }
  };
}
