import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

const stateDir = path.resolve("data/state");
const configFile = path.join(stateDir, "config.json");

async function exists(file) {
  try {
    await readFile(file, "utf8");
    return true;
  } catch {
    return false;
  }
}

function getBootstrapModels() {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const preferred = [
    ["openai-codex", "gpt-5.4"],
    ["openai-codex", "gpt-5.4-mini"],
    ["openai", "gpt-4.1"],
    ["anthropic", "claude-sonnet-4-6"],
    ["anthropic", "claude-opus-4-6"],
    ["google", "gemini-3.1-pro-preview"],
  ];

  const models = preferred
    .map(([provider, model]) => modelRegistry.find(provider, model))
    .filter(Boolean)
    .map((model) => ({ provider: model.provider, id: model.id, label: `${model.provider}/${model.id}` }));

  if (!models.length) {
    return modelRegistry.getAll().slice(0, 10).map((model) => ({
      provider: model.provider,
      id: model.id,
      label: `${model.provider}/${model.id}`,
    }));
  }

  return models;
}

function getOAuthProviderForModelProvider(provider) {
  if (provider === "openai-codex") return "openai-codex";
  if (provider === "anthropic") return "anthropic";
  if (provider === "google") return "google-gemini-cli";
  if (provider === "google-antigravity") return "google-antigravity";
  if (provider === "github-copilot") return "github-copilot";
  return provider;
}

function hasExistingPiAuth(provider) {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const oauthProvider = getOAuthProviderForModelProvider(provider);
  return modelRegistry.hasConfiguredAuth(provider) || authStorage.hasAuth(oauthProvider);
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

async function runInternalPiLogin(provider, rl) {
  const authStorage = AuthStorage.create();
  const oauthProvider = getOAuthProviderForModelProvider(provider);
  const available = authStorage.getOAuthProviders();
  const selected = available.find((item) => item.id === oauthProvider);
  if (!selected) {
    throw new Error(`No internal OAuth login flow is available for ${provider}.`);
  }

  let manualCodeResolve;
  let manualCodeReject;
  const manualCodePromise = new Promise((resolve, reject) => {
    manualCodeResolve = resolve;
    manualCodeReject = reject;
  });

  await authStorage.login(oauthProvider, {
    onAuth: async ({ url, instructions }) => {
      console.log(`${instructions || "Open this URL to continue authentication:"}\n${url}\n`);
      await maybeOpenExternal(url);
      if (selected.usesCallbackServer) {
        const pasted = (await rl.question("Paste the redirect URL here if the browser does not return automatically, or press Enter to keep waiting: ")).trim();
        if (pasted && manualCodeResolve) {
          manualCodeResolve(pasted);
          manualCodeResolve = undefined;
        }
      }
    },
    onDeviceCode: async ({ userCode, verificationUri }) => {
      console.log(`Open this URL: ${verificationUri}`);
      console.log(`Then enter code: ${userCode}\n`);
      await maybeOpenExternal(verificationUri);
    },
    onPrompt: async ({ message }) => {
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

export async function bootstrapIfNeeded({ force = false } = {}) {
  await mkdir(stateDir, { recursive: true });
  if (!force && await exists(configFile)) return;

  const rl = readline.createInterface({ input, output });
  const ask = async (label, fallback = "") => {
    const suffix = fallback ? ` (${fallback})` : "";
    const value = (await rl.question(`${label}${suffix}: `)).trim();
    return value || fallback;
  };

  const askYesNo = async (label, fallback = true) => {
    const hint = fallback ? "Y/n" : "y/N";
    const value = (await rl.question(`${label} (${hint}): `)).trim().toLowerCase();
    if (!value) return fallback;
    return value === "y" || value === "yes";
  };

  console.log("\n== Arisa bootstrap ==\n");
  console.log("Telegram bot token tip: get it from https://t.me/BotFather");
  const telegramApiKey = await ask("Telegram API key / bot token");
  const telegramMaxChatIds = Number(await ask("Maximum authorized chat IDs", "1"));

  const models = getBootstrapModels();
  console.log("\nAvailable Pi models:");
  models.forEach((model, index) => {
    const authStatus = hasExistingPiAuth(model.provider) ? "auth: configured" : "auth: missing";
    const providerLabel = model.provider;
    console.log(`${index + 1}. ${providerLabel}/${model.id} (${authStatus})`);
  });
  const selectedIndex = Number(await ask("Select Pi model by number", "1"));
  const selectedModel = models[Math.max(0, Math.min(models.length - 1, selectedIndex - 1))];
  const selectedAuthReady = hasExistingPiAuth(selectedModel.provider);
  console.log(`Selected model: ${selectedModel.provider}/${selectedModel.id}`);
  console.log(`Existing Pi auth for ${selectedModel.provider}: ${selectedAuthReady ? "yes" : "no"}`);
  console.log("Pi auth tip: if this provider supports Pi login, leaving the API key empty will start the internal login flow.");

  let piApiKey = "";
  while (true) {
    piApiKey = (await rl.question(`Pi API key for ${selectedModel.provider} (optional): `)).trim();
    if (piApiKey) break;
    if (hasExistingPiAuth(selectedModel.provider)) break;

    const oauthProvider = getOAuthProviderForModelProvider(selectedModel.provider);
    const supportsInternalLogin = oauthProvider !== selectedModel.provider || ["anthropic", "openai-codex", "google-gemini-cli", "google-antigravity", "github-copilot"].includes(oauthProvider);
    if (!supportsInternalLogin) {
      console.log(`No existing Pi auth found for ${selectedModel.provider}. This provider requires an API key.`);
      continue;
    }

    console.log(`No existing Pi auth found for ${selectedModel.provider}. Starting internal Pi login...`);
    try {
      await runInternalPiLogin(selectedModel.provider, rl);
    } catch (error) {
      console.log(`Internal Pi login failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (hasExistingPiAuth(selectedModel.provider)) {
      console.log(`Detected Pi auth for ${selectedModel.provider}. Continuing bootstrap.`);
      break;
    }

    console.log(`Pi auth for ${selectedModel.provider} is still missing after login.`);
  }

  const config = {
    telegram: {
      apiKey: telegramApiKey,
      maxChatIds: telegramMaxChatIds,
      authorizedChatIds: []
    },
    pi: {
      provider: selectedModel.provider,
      model: selectedModel.id,
      apiKey: piApiKey
    },
    createdAt: new Date().toISOString()
  };

  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  rl.close();
  console.log(`\nConfig saved to ${configFile}\n`);
}

export { configFile };
