import { Bot } from "grammy";
import { createPiOAuthLogin } from "../core/agent/pi-auth-login.js";
import {
  createPiRuntime,
  formatPiModelOption,
  hasProviderAuth,
  listPiProviders,
  listProviderModels,
  supportsProviderOAuth
} from "../core/agent/pi-runtime.js";
import { telegramConfigDefaults } from "../core/config/config-defaults.js";
import { buildDeviceCodeTelegramMessage } from "../transport/telegram/device-code-message.js";
import { buildPagedInlineKeyboard } from "../transport/telegram/paged-inline-keyboard.js";
import {
  buildBootstrapConfig,
  formatProviderOption,
  getIncomingChatMeta,
  parseYesNo,
  selectPiLoginOption,
  sortBootstrapModels,
  sortBootstrapProviders
} from "./bootstrap-config.js";

export async function runTelegramBootstrap({ telegramApiKey, setupToken, botInfo }) {
  const bot = new Bot(telegramApiKey);
  const runtime = createPiRuntime();
  const providers = sortBootstrapProviders(listPiProviders(runtime));
  let setupChatId = null;
  let chatMeta = {};
  let state = "await-start";
  let telegramMaxChatIds = 1;
  let selectedProvider = null;
  let selectedModel = null;
  let piApiKey = "";
  let activeLogin = null;
  let completed = false;
  let resolveResult;
  let rejectResult;

  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const sendSetupMessage = async (text, extra = {}) => {
    if (!setupChatId) return;
    await bot.api.sendMessage(setupChatId, text, extra);
  };

  const showSetupPrompt = async (ctx, text, extra = {}) => {
    const messageId = ctx?.callbackQuery?.message?.message_id;
    if (messageId && ctx.chat?.id) {
      try {
        await ctx.api.editMessageText(ctx.chat.id, messageId, text, extra);
        return;
      } catch {}
    }
    await sendSetupMessage(text, extra);
  };

  const isSetupChat = (ctx) => setupChatId && ctx.chat?.id === setupChatId;

  const complete = (startInBackground) => {
    if (completed) return;
    completed = true;
    resolveResult({
      config: buildBootstrapConfig({
        telegramApiKey,
        telegramMaxChatIds,
        authorizedChatIds: [setupChatId],
        chatMeta: { [setupChatId]: chatMeta },
        provider: selectedProvider.provider,
        model: selectedModel.id,
        piApiKey
      }),
      startInBackground,
      viaTelegram: true
    });
  };

  const askProvider = async (ctx = null, page = 0) => {
    state = "provider";
    await showSetupPrompt(ctx, "Select the Pi provider Arisa should use:", {
      reply_markup: buildPagedInlineKeyboard("provider", providers.map((provider) => ({ text: formatProviderOption(provider) })), {
        page,
        pageSize: telegramConfigDefaults.modelPickerPageSize
      })
    });
  };

  const askModel = async (ctx = null, page = 0) => {
    state = "model";
    const models = sortBootstrapModels(selectedProvider.provider, listProviderModels(selectedProvider.provider, createPiRuntime()));
    const keyboard = buildPagedInlineKeyboard("model", models.map((model) => ({ text: formatPiModelOption(model) })), {
      page,
      pageSize: telegramConfigDefaults.modelPickerPageSize
    });
    keyboard.inline_keyboard.push([{ text: "Back to providers", callback_data: "back:provider" }]);
    await showSetupPrompt(ctx, `Select the model for ${selectedProvider.provider}:`, { reply_markup: keyboard });
  };

  const askBackground = async (ctx = null) => {
    state = "background";
    await showSetupPrompt(ctx, "Bootstrap complete. Keep Arisa running in background now?", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Yes, start in background", callback_data: "background:yes" }],
          [{ text: "No, continue in foreground", callback_data: "background:no" }]
        ]
      }
    });
  };

  const askApiKey = async (ctx = null) => {
    state = "pi-api-key";
    await showSetupPrompt(ctx, `Send the Pi API key for ${selectedProvider.provider}.`, {
      reply_markup: { inline_keyboard: [] }
    });
  };

  const askAuthMethod = async (ctx = null) => {
    const providerRuntime = createPiRuntime();
    const selectedAuthReady = hasProviderAuth(selectedProvider.provider, providerRuntime);
    const providerSupportsOAuth = supportsProviderOAuth(selectedProvider.provider, providerRuntime);
    const buttons = [];
    if (selectedAuthReady) buttons.push([{ text: "Use existing Pi auth", callback_data: "auth:existing" }]);
    if (providerSupportsOAuth) {
      buttons.push([{ text: selectedAuthReady ? "Run Pi login again" : "Start Pi login", callback_data: "auth:login" }]);
    }
    buttons.push([{ text: "Enter API key", callback_data: "auth:key" }]);
    buttons.push([{ text: "Back to models", callback_data: "back:model" }]);

    state = "auth-method";
    await showSetupPrompt(ctx, [
      `Selected model: ${selectedProvider.provider}/${selectedModel.id}`,
      `Existing Pi auth for ${selectedProvider.provider}: ${selectedAuthReady ? "yes" : "no"}`,
      "Choose how Arisa should authenticate Pi."
    ].join("\n"), { reply_markup: { inline_keyboard: buttons } });
  };

  const finishPiLogin = async (login) => {
    try {
      await login.promise;
      activeLogin = null;
      if (hasProviderAuth(selectedProvider.provider, createPiRuntime())) {
        await sendSetupMessage(`Detected Pi auth for ${selectedProvider.provider}.`);
        await askBackground();
        return;
      }
      await sendSetupMessage(`Pi auth for ${selectedProvider.provider} is still missing after login.`);
      await askAuthMethod();
    } catch (error) {
      activeLogin = null;
      await sendSetupMessage(`Pi login failed: ${error instanceof Error ? error.message : String(error)}`);
      await askAuthMethod();
    }
  };

  const startPiLogin = async () => {
    if (hasProviderAuth(selectedProvider.provider, createPiRuntime())) {
      await sendSetupMessage(`Existing Pi auth for ${selectedProvider.provider} detected.`);
      await askBackground();
      return;
    }

    state = "pi-login";
    const login = createPiOAuthLogin({
      provider: selectedProvider.provider,
      onSelect: async ({ message, options }) => {
        const selected = selectPiLoginOption(options);
        if (!selected) return undefined;
        await sendSetupMessage(`${message}\nUsing: ${selected.label || selected.id}`);
        return selected.id;
      },
      onAuth: async ({ url, instructions }) => {
        await sendSetupMessage([
          instructions || "Open this URL to continue Pi authentication:",
          url,
          "After login, paste the full redirect URL back here."
        ].join("\n"));
      },
      onDeviceCode: async ({ userCode, verificationUri, expiresInSeconds }) => {
        const { text, ...options } = buildDeviceCodeTelegramMessage({ userCode, verificationUri, expiresInSeconds });
        await sendSetupMessage(text, options);
      },
      onPrompt: async ({ message, controller }) => {
        await sendSetupMessage(`${message}\nReply here with the value.`);
        return controller.waitForManualCode();
      },
      onProgress: (message) => {
        if (message) console.log(`[bootstrap] Pi auth progress: ${message}`);
      }
    });

    activeLogin = login;
    finishPiLogin(login);
  };

  bot.catch((error) => console.error("Telegram setup bot error:", error));

  bot.command("start", async (ctx) => {
    if (String(ctx.match || "").trim() !== setupToken) {
      await ctx.reply("Invalid setup link. Use the link shown in the Arisa bootstrap terminal.");
      return;
    }
    if (setupChatId && ctx.chat.id !== setupChatId) {
      await ctx.reply("This setup session is already connected to another chat.");
      return;
    }
    setupChatId = ctx.chat.id;
    chatMeta = getIncomingChatMeta(ctx);
    await ctx.reply([
      `Connected to @${botInfo.username}.`,
      "This chat will be the only Telegram chat authorized during setup."
    ].join("\n"));
    await askProvider();
  });

  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!isSetupChat(ctx)) return;
    const data = String(ctx.callbackQuery.data || "");
    const [action, rawValue] = data.split(":");
    if (action === "noop") return;
    if (action === "back" && rawValue === "provider" && state === "model") {
      selectedProvider = null;
      selectedModel = null;
      await askProvider(ctx);
      return;
    }
    if (action === "back" && rawValue === "model" && state === "auth-method") {
      selectedModel = null;
      await askModel(ctx);
      return;
    }
    if (action === "provider-page" && state === "provider") {
      await askProvider(ctx, Number(rawValue));
      return;
    }
    if (action === "model-page" && state === "model") {
      await askModel(ctx, Number(rawValue));
      return;
    }
    if (action === "provider" && state === "provider") {
      selectedProvider = providers[Number(rawValue)];
      if (!selectedProvider) return;
      await askModel(ctx);
      return;
    }
    if (action === "model" && state === "model") {
      const models = sortBootstrapModels(selectedProvider.provider, listProviderModels(selectedProvider.provider, createPiRuntime()));
      selectedModel = models[Number(rawValue)];
      if (!selectedModel) return;
      await askAuthMethod(ctx);
      return;
    }
    if (action === "auth" && state === "auth-method") {
      if (rawValue === "existing") {
        if (hasProviderAuth(selectedProvider.provider, createPiRuntime())) {
          await askBackground(ctx);
        } else {
          await sendSetupMessage(`No existing Pi auth found for ${selectedProvider.provider}.`);
          await askAuthMethod(ctx);
        }
        return;
      }
      if (rawValue === "login") {
        await startPiLogin();
        return;
      }
      if (rawValue === "key") {
        await askApiKey(ctx);
        return;
      }
    }
    if (action === "background" && state === "background") {
      await sendSetupMessage(rawValue === "yes"
        ? "Saving config. Arisa will start in background now."
        : "Saving config. Arisa will continue in foreground.");
      complete(rawValue === "yes");
    }
  });

  bot.on("message:text", async (ctx) => {
    if (!isSetupChat(ctx)) return;
    const text = String(ctx.message.text || "").trim();
    if (!text || text.startsWith("/")) return;
    if (state === "pi-api-key") {
      piApiKey = text;
      await askBackground();
      return;
    }
    if (state === "pi-login" && activeLogin?.manualInputRequested) {
      if (activeLogin.submitManualCode(text)) await ctx.reply("Got it. Finishing Pi login now...");
      return;
    }
    if (state === "background") {
      const answer = parseYesNo(text, true);
      if (answer === null) {
        await ctx.reply("Please answer yes or no.");
        return;
      }
      await ctx.reply(answer
        ? "Saving config. Arisa will start in background now."
        : "Saving config. Arisa will continue in foreground.");
      complete(answer);
    }
  });

  await bot.api.deleteWebhook({ drop_pending_updates: true });
  console.log("Waiting for Telegram setup to complete...");
  const polling = bot.start().then(() => {
    if (!completed) throw new Error("Telegram setup bot stopped before bootstrap completed.");
  });

  try {
    return await Promise.race([resultPromise, polling]);
  } catch (error) {
    rejectResult(error);
    throw error;
  } finally {
    bot.stop();
    await polling.catch(() => {});
  }
}
