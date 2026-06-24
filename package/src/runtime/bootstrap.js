import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { Bot } from "grammy";
import { createPiOAuthLogin } from "../core/agent/pi-auth-login.js";
import { createPiRuntime, hasProviderAuth, listPiProviders, listProviderModels, supportsProviderOAuth } from "../core/agent/pi-runtime.js";
import { configFile, ensureArisaHome } from "./paths.js";

const ARISA_BANNER = [
  " █████╗ ██████╗ ██╗███████╗ █████╗ ",
  "██╔══██╗██╔══██╗██║██╔════╝██╔══██╗",
  "███████║██████╔╝██║███████╗███████║",
  "██╔══██║██╔══██╗██║╚════██║██╔══██║",
  "██║  ██║██║  ██║██║███████║██║  ██║",
  "╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚══════╝╚═╝  ╚═╝"
].join("\n");

async function exists(file) {
  try {
    await readFile(file, "utf8");
    return true;
  } catch {
    return false;
  }
}

function buildConfig({ telegramApiKey, telegramMaxChatIds, authorizedChatIds = [], chatMeta = {}, provider, model, piApiKey }) {
  return {
    telegram: {
      token: telegramApiKey,
      maxChatIds: telegramMaxChatIds,
      authorizedChatIds,
      chatMeta
    },
    pi: {
      provider,
      model,
      apiKey: piApiKey
    },
    createdAt: new Date().toISOString()
  };
}

function sortBootstrapProviders(providers) {
  const preferredOrder = ["openai-codex"];
  const positions = new Map(providers.map((provider, index) => [provider.provider, index]));

  return [...providers].sort((a, b) => {
    const aPref = preferredOrder.indexOf(a.provider);
    const bPref = preferredOrder.indexOf(b.provider);
    const aRank = aPref === -1 ? Number.MAX_SAFE_INTEGER : aPref;
    const bRank = bPref === -1 ? Number.MAX_SAFE_INTEGER : bPref;
    if (aRank !== bRank) return aRank - bRank;
    return (positions.get(a.provider) || 0) - (positions.get(b.provider) || 0);
  });
}

function sortBootstrapModels(provider, models) {
  const preferred = {
    "openai-codex": ["gpt-5.5"]
  };

  const priority = preferred[provider] || [];
  const positions = new Map(models.map((model, index) => [model.id, index]));

  return [...models].sort((a, b) => {
    const aIndex = priority.indexOf(a.id);
    const bIndex = priority.indexOf(b.id);
    const aRank = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
    const bRank = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
    if (aRank !== bRank) return aRank - bRank;
    return (positions.get(b.id) || 0) - (positions.get(a.id) || 0);
  });
}

function createSetupToken() {
  return crypto.randomBytes(18).toString("base64url");
}

function parsePositiveInteger(value, fallback = null) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function selectByIndex(items, value, fallbackIndex = 0) {
  const index = parsePositiveInteger(value, fallbackIndex + 1) - 1;
  return items[Math.max(0, Math.min(items.length - 1, index))];
}

function parseYesNo(value, fallback = true) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["y", "yes", "s", "si", "sí"].includes(text)) return true;
  if (["n", "no"].includes(text)) return false;
  return null;
}

function buildPagedInlineKeyboard(action, items, { page = 0, pageSize = 8 } = {}) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.max(0, Math.min(pageCount - 1, page));
  const startIndex = currentPage * pageSize;
  const rows = items.slice(startIndex, startIndex + pageSize).map((item, index) => ([{
    text: item.text,
    callback_data: `${action}:${startIndex + index}`
  }]));

  if (pageCount > 1) {
    const navigation = [];
    if (currentPage > 0) {
      navigation.push({ text: "Previous", callback_data: `${action}-page:${currentPage - 1}` });
    }
    navigation.push({ text: `${currentPage + 1}/${pageCount}`, callback_data: "noop:page" });
    if (currentPage < pageCount - 1) {
      navigation.push({ text: "Next", callback_data: `${action}-page:${currentPage + 1}` });
    }
    rows.push(navigation);
  }

  return { inline_keyboard: rows };
}

function getIncomingChatMeta(ctx) {
  return {
    languageCode: ctx.from?.language_code || "",
    username: ctx.from?.username || "",
    firstName: ctx.from?.first_name || "",
    lastName: ctx.from?.last_name || ""
  };
}

function formatProviderOption(item) {
  const authLabel = item.authConfigured ? "auth configured" : item.supportsOAuth ? "login or API key" : "API key";
  return `${item.provider} (${item.modelCount} models, ${authLabel})`;
}

function formatModelOption(model) {
  const capabilities = [model.reasoning ? "reasoning" : null, model.input?.includes("image") ? "image" : null].filter(Boolean).join(", ");
  return capabilities ? `${model.id} [${capabilities}]` : model.id;
}

function selectPiLoginOption(options = []) {
  return options.find((option) => /device/i.test(`${option.id} ${option.label}`))
    || options.find((option) => /browser|oauth|web/i.test(`${option.id} ${option.label}`))
    || options[0]
    || null;
}

async function maybeOpenExternal(url) {
  if (!url) return;
  await new Promise((resolve) => {
    let child;
    if (process.platform === "darwin") {
      child = spawn("open", [url], { stdio: "ignore" });
    } else if (process.platform === "win32") {
      child = spawn("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    } else {
      child = spawn("xdg-open", [url], { stdio: "ignore" });
    }
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

async function runInternalPiLogin(provider, { rl = null } = {}) {
  const login = createPiOAuthLogin({
    provider,
    onSelect: async ({ message, options }) => {
      const selected = selectPiLoginOption(options);
      if (!selected) return undefined;
      console.log(`${message}\nUsing: ${selected.label || selected.id}\n`);
      return selected.id;
    },
    onAuth: async ({ url, instructions, controller }) => {
      console.log(`${instructions || "Open this URL to continue authentication:"}\n${url}\n`);
      await maybeOpenExternal(url);
      if (controller.oauthProvider.usesCallbackServer && rl) {
        const pasted = (await rl.question("Paste the redirect URL here if the browser does not return automatically, or press Enter to keep waiting: ")).trim();
        if (pasted) controller.submitManualCode(pasted);
      }
    },
    onDeviceCode: async ({ userCode, verificationUri }) => {
      console.log(`Open this URL: ${verificationUri}`);
      console.log(`Then enter code: ${userCode}\n`);
      await maybeOpenExternal(verificationUri);
    },
    onPrompt: async ({ message }) => {
      if (!rl) {
        throw new Error(`Pi login for ${provider} requires interactive input: ${message}`);
      }
      return (await rl.question(`${message} `)).trim();
    },
    onProgress: (message) => {
      console.log(message);
    }
  });
  await login.promise;
}

async function collectCliBootstrapChoices({ telegramApiKey, rl, ask }) {
  const telegramMaxChatIds = Number(await ask("Maximum authorized chat IDs", "1"));

  const runtime = createPiRuntime();
  const providers = sortBootstrapProviders(listPiProviders(runtime));
  console.log("\nAvailable Pi providers:");
  providers.forEach((item, index) => {
    console.log(`${index + 1}. ${formatProviderOption(item)}`);
  });

  const selectedProvider = selectByIndex(providers, await ask("Select Pi provider by number", "1"));
  const models = sortBootstrapModels(selectedProvider.provider, listProviderModels(selectedProvider.provider, runtime));
  console.log(`\nAvailable models for ${selectedProvider.provider}:`);
  models.forEach((model, index) => {
    console.log(`${index + 1}. ${formatModelOption(model)}`);
  });

  const selectedModel = selectByIndex(models, await ask("Select Pi model by number", "1"));
  const selectedAuthReady = hasProviderAuth(selectedProvider.provider, runtime);
  const providerSupportsOAuth = supportsProviderOAuth(selectedProvider.provider, runtime);
  console.log(`Selected model: ${selectedModel.provider}/${selectedModel.id}`);
  console.log(`Existing Pi auth for ${selectedProvider.provider}: ${selectedAuthReady ? "yes" : "no"}`);
  if (providerSupportsOAuth) {
    console.log("Pi auth tip: leaving the API key empty will start Pi's internal login flow for this provider.");
  }

  let piApiKey = "";
  while (true) {
    piApiKey = (await rl.question(`Pi API key for ${selectedProvider.provider} (optional): `)).trim();
    if (piApiKey) break;
    if (hasProviderAuth(selectedProvider.provider, createPiRuntime())) break;

    if (!providerSupportsOAuth) {
      console.log(`No existing Pi auth found for ${selectedProvider.provider}. This provider requires an API key.`);
      continue;
    }

    console.log(`No existing Pi auth found for ${selectedProvider.provider}. Starting internal Pi login...`);
    try {
      await runInternalPiLogin(selectedProvider.provider, { rl });
    } catch (error) {
      console.log(`Internal Pi login failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (hasProviderAuth(selectedProvider.provider, createPiRuntime())) {
      console.log(`Detected Pi auth for ${selectedProvider.provider}. Continuing bootstrap.`);
      break;
    }

    console.log(`Pi auth for ${selectedProvider.provider} is still missing after login.`);
  }

  return {
    config: buildConfig({
      telegramApiKey,
      telegramMaxChatIds,
      provider: selectedProvider.provider,
      model: selectedModel.id,
      piApiKey
    }),
    startInBackground: false,
    viaTelegram: false
  };
}

async function runTelegramBootstrap({ telegramApiKey, setupToken, botInfo }) {
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
      config: buildConfig({
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
      reply_markup: buildPagedInlineKeyboard("provider", providers.map((provider) => ({ text: formatProviderOption(provider) })), { page })
    });
  };

  const askModel = async (ctx = null, page = 0) => {
    state = "model";
    const models = sortBootstrapModels(selectedProvider.provider, listProviderModels(selectedProvider.provider, createPiRuntime()));
    await showSetupPrompt(ctx, `Select the model for ${selectedProvider.provider}:`, {
      reply_markup: buildPagedInlineKeyboard("model", models.map((model) => ({ text: formatModelOption(model) })), { page })
    });
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

    if (selectedAuthReady) {
      buttons.push([{ text: "Use existing Pi auth", callback_data: "auth:existing" }]);
    }
    if (providerSupportsOAuth) {
      buttons.push([{ text: selectedAuthReady ? "Run Pi login again" : "Start Pi login", callback_data: "auth:login" }]);
    }
    buttons.push([{ text: "Enter API key", callback_data: "auth:key" }]);

    state = "auth-method";
    await showSetupPrompt(ctx, [
      `Selected model: ${selectedProvider.provider}/${selectedModel.id}`,
      `Existing Pi auth for ${selectedProvider.provider}: ${selectedAuthReady ? "yes" : "no"}`,
      "Choose how Arisa should authenticate Pi."
    ].join("\n"), {
      reply_markup: { inline_keyboard: buttons }
    });
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
        const expiry = expiresInSeconds ? `\nExpires in ${Math.round(expiresInSeconds / 60)} minute(s).` : "";
        await sendSetupMessage(`Open this URL: ${verificationUri}\nThen enter code: ${userCode}${expiry}`);
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

  bot.catch((error) => {
    console.error("Telegram setup bot error:", error);
  });

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
      if (activeLogin.submitManualCode(text)) {
        await ctx.reply("Got it. Finishing Pi login now...");
      }
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

export async function bootstrapIfNeeded({ force = false } = {}) {
  await ensureArisaHome();
  if (!force && await exists(configFile)) {
    return { configCreated: false, viaTelegram: false, startInBackground: false };
  }

  const rl = readline.createInterface({ input, output });
  const ask = async (label, fallback = "") => {
    const suffix = fallback ? ` (${fallback})` : "";
    const value = (await rl.question(`${label}${suffix}: `)).trim();
    return value || fallback;
  };

  console.log(`\n${ARISA_BANNER}`);
  console.log("-------- https://arisa.sh --------\n");
  console.log("Get Telegram bot token from https://t.me/BotFather");
  const telegramApiKey = await ask("Telegram bot token");

  try {
    const setupProbeBot = new Bot(telegramApiKey);
    const botInfo = await setupProbeBot.api.getMe();
    const answer = parseYesNo(await ask("Continue bootstrap from Telegram?", "Y"), true);
    const continueFromTelegram = answer === null ? true : answer;

    let result;
    if (continueFromTelegram) {
      const setupToken = createSetupToken();
      const setupLink = `https://t.me/${botInfo.username}?start=${setupToken}`;
      console.log(`\nOpen this link to continue setup in Telegram:\n${setupLink}\n`);
      await maybeOpenExternal(setupLink);
      result = await runTelegramBootstrap({ telegramApiKey, setupToken, botInfo });
    } else {
      result = await collectCliBootstrapChoices({ telegramApiKey, rl, ask });
    }

    await writeFile(configFile, `${JSON.stringify(result.config, null, 2)}\n`, "utf8");
    console.log(`\nConfig saved to ${configFile}\n`);
    return {
      configCreated: true,
      viaTelegram: result.viaTelegram,
      startInBackground: result.startInBackground
    };
  } finally {
    rl.close();
  }
}

export { configFile };
