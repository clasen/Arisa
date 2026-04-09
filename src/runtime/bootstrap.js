import { readFile, writeFile } from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { createPiRuntime, hasProviderAuth, listPiProviders, listProviderModels, supportsProviderOAuth } from "../core/agent/pi-runtime.js";
import { configFile, ensureArisaHome } from "./paths.js";

async function exists(file) {
  try {
    await readFile(file, "utf8");
    return true;
  } catch {
    return false;
  }
}

function normalizeString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function parseMaxChatIds(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function buildConfig({ telegramApiKey, telegramMaxChatIds, provider, model, piApiKey }) {
  return {
    telegram: {
      apiKey: telegramApiKey,
      maxChatIds: telegramMaxChatIds,
      authorizedChatIds: [],
      chatMeta: {}
    },
    pi: {
      provider,
      model,
      apiKey: piApiKey
    },
    createdAt: new Date().toISOString()
  };
}

function resolvePiDefaults(runtime, { provider: preferredProvider = "", model: preferredModel = "" } = {}) {
  const providers = sortBootstrapProviders(listPiProviders(runtime));
  if (!providers.length) {
    throw new Error("No Pi providers are available for bootstrap.");
  }

  const preferredProviderValue = normalizeString(preferredProvider);
  const providerExists = providers.some((item) => item.provider === preferredProviderValue);
  if (preferredProviderValue && !providerExists) {
    console.log(`Ignoring unknown Pi provider override: ${preferredProviderValue}`);
  }

  const selectedProvider = providerExists
    ? preferredProviderValue
    : providers[0].provider;

  const models = sortBootstrapModels(selectedProvider, listProviderModels(selectedProvider, runtime));
  if (!models.length) {
    throw new Error(`No Pi models are available for provider ${selectedProvider}.`);
  }

  const preferredModelValue = normalizeString(preferredModel);
  const modelExists = models.some((item) => item.id === preferredModelValue);
  if (preferredModelValue && !modelExists) {
    console.log(`Ignoring unknown Pi model override for ${selectedProvider}: ${preferredModelValue}`);
  }

  const selectedModel = modelExists ? preferredModelValue : models[0].id;
  return { provider: selectedProvider, model: selectedModel };
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
    "openai-codex": ["gpt-5.4"]
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

async function runInternalPiLogin(provider, { rl = null, allowManualInput = true } = {}) {
  const authStorage = AuthStorage.create();
  const selected = authStorage.getOAuthProviders().find((item) => item.id === provider);
  if (!selected) {
    throw new Error(`No internal OAuth login flow is available for ${provider}.`);
  }

  let manualCodeResolve;
  let manualCodeReject;
  const manualCodePromise = new Promise((resolve, reject) => {
    manualCodeResolve = resolve;
    manualCodeReject = reject;
  });

  await authStorage.login(provider, {
    onAuth: async ({ url, instructions }) => {
      console.log(`${instructions || "Open this URL to continue authentication:"}\n${url}\n`);
      await maybeOpenExternal(url);
      if (selected.usesCallbackServer && allowManualInput && rl) {
        const pasted = (await rl.question("Paste the redirect URL here if the browser does not return automatically, or press Enter to keep waiting: ")).trim();
        if (pasted && manualCodeResolve) {
          manualCodeResolve(pasted);
          manualCodeResolve = undefined;
        }
      } else if (selected.usesCallbackServer && !allowManualInput) {
        console.log("Waiting for Pi login callback from your browser...");
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
    },
    onManualCodeInput: () => manualCodePromise,
  }).finally(() => {
    if (manualCodeResolve) {
      manualCodeResolve("");
      manualCodeResolve = undefined;
    }
    manualCodeReject = undefined;
  });
}

export async function bootstrapIfNeeded({ force = false, cliConfigOverrides = {} } = {}) {
  await ensureArisaHome();
  if (!force && await exists(configFile)) return;

  const telegramApiKeyFromCli = normalizeString(cliConfigOverrides?.telegram?.apiKey);
  if (telegramApiKeyFromCli) {
    const runtime = createPiRuntime();
    const resolvedPi = resolvePiDefaults(runtime, cliConfigOverrides?.pi || {});
    const telegramMaxChatIds = parseMaxChatIds(cliConfigOverrides?.telegram?.maxChatIds, 1);
    let piApiKey = normalizeString(cliConfigOverrides?.pi?.apiKey);
    if (!piApiKey && !hasProviderAuth(resolvedPi.provider, runtime)) {
      if (!supportsProviderOAuth(resolvedPi.provider, runtime)) {
        throw new Error(
          `No auth found for ${resolvedPi.provider}. Provide --pi.apiKey for non-interactive bootstrap, or rerun bootstrap interactively to configure auth.`
        );
      }
      console.log(`No existing Pi auth found for ${resolvedPi.provider}. Starting internal Pi login...`);
      await runInternalPiLogin(resolvedPi.provider, { allowManualInput: false });
      if (!hasProviderAuth(resolvedPi.provider, createPiRuntime())) {
        throw new Error(
          `Pi login did not complete for ${resolvedPi.provider}. Finish authentication in the browser and retry, or provide --pi.apiKey.`
        );
      }
      console.log(`Detected Pi auth for ${resolvedPi.provider}. Continuing bootstrap.`);
    }
    const config = buildConfig({
      telegramApiKey: telegramApiKeyFromCli,
      telegramMaxChatIds,
      provider: resolvedPi.provider,
      model: resolvedPi.model,
      piApiKey
    });
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    console.log(`\nConfig saved to ${configFile} (non-interactive bootstrap)\n`);
    return;
  }

  const rl = readline.createInterface({ input, output });
  const ask = async (label, fallback = "") => {
    const suffix = fallback ? ` (${fallback})` : "";
    const value = (await rl.question(`${label}${suffix}: `)).trim();
    return value || fallback;
  };

  console.log("\n== Arisa bootstrap ==\n");
  console.log("Telegram bot token tip: get it from https://t.me/BotFather");
  const telegramApiKey = await ask("Telegram API key / bot token");
  const telegramMaxChatIds = Number(await ask("Maximum authorized chat IDs", "1"));

  const runtime = createPiRuntime();
  const providers = sortBootstrapProviders(listPiProviders(runtime));
  console.log("\nAvailable Pi providers:");
  providers.forEach((item, index) => {
    const authLabel = item.authConfigured ? "auth: configured" : item.supportsOAuth ? "auth: login or API key" : "auth: API key";
    console.log(`${index + 1}. ${item.provider} (${item.modelCount} models, ${authLabel})`);
  });

  const selectedProviderIndex = Number(await ask("Select Pi provider by number", "1"));
  const selectedProvider = providers[Math.max(0, Math.min(providers.length - 1, selectedProviderIndex - 1))];
  const models = sortBootstrapModels(selectedProvider.provider, listProviderModels(selectedProvider.provider, runtime));
  console.log(`\nAvailable models for ${selectedProvider.provider}:`);
  models.forEach((model, index) => {
    const capabilities = [model.reasoning ? "reasoning" : null, model.input?.includes("image") ? "image" : null].filter(Boolean).join(", ");
    const suffix = capabilities ? ` [${capabilities}]` : "";
    console.log(`${index + 1}. ${model.id}${suffix}`);
  });

  const selectedModelIndex = Number(await ask("Select Pi model by number", "1"));
  const selectedModel = models[Math.max(0, Math.min(models.length - 1, selectedModelIndex - 1))];
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

  const config = buildConfig({
    telegramApiKey,
    telegramMaxChatIds,
    provider: selectedProvider.provider,
    model: selectedModel.id,
    piApiKey
  });

  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  rl.close();
  console.log(`\nConfig saved to ${configFile}\n`);
}

export { configFile };
