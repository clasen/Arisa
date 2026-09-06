import { spawn } from "node:child_process";
import { createPiOAuthLogin } from "../core/agent/pi-auth-login.js";
import {
  createPiRuntime,
  formatPiModelOption,
  hasProviderAuth,
  listPiProviders,
  listProviderModels,
  supportsProviderOAuth
} from "../core/agent/pi-runtime.js";
import {
  buildBootstrapConfig,
  formatProviderOption,
  selectByIndex,
  selectPiLoginOption,
  sortBootstrapModels,
  sortBootstrapProviders
} from "./bootstrap-config.js";

export async function openExternal(url) {
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
      await openExternal(url);
      if (controller.oauthProvider.usesCallbackServer && rl) {
        const pasted = (await rl.question("Paste the redirect URL here if the browser does not return automatically, or press Enter to keep waiting: ")).trim();
        if (pasted) controller.submitManualCode(pasted);
      }
    },
    onDeviceCode: async ({ userCode, verificationUri }) => {
      console.log(`Open this URL: ${verificationUri}`);
      console.log(`Then enter code: ${userCode}\n`);
      await openExternal(verificationUri);
    },
    onPrompt: async ({ message }) => {
      if (!rl) throw new Error(`Pi login for ${provider} requires interactive input: ${message}`);
      return (await rl.question(`${message} `)).trim();
    },
    onProgress: (message) => console.log(message)
  });
  await login.promise;
}

export async function collectCliBootstrapChoices({ telegramApiKey, rl, ask }) {
  const telegramMaxChatIds = Number(await ask("Maximum authorized chat IDs", "1"));
  const runtime = await createPiRuntime();
  const providers = sortBootstrapProviders(listPiProviders(runtime));
  console.log("\nAvailable Pi providers:");
  providers.forEach((item, index) => console.log(`${index + 1}. ${formatProviderOption(item)}`));

  const selectedProvider = selectByIndex(providers, await ask("Select Pi provider by number", "1"));
  const models = sortBootstrapModels(selectedProvider.provider, listProviderModels(selectedProvider.provider, runtime));
  console.log(`\nAvailable models for ${selectedProvider.provider}:`);
  models.forEach((model, index) => console.log(`${index + 1}. ${formatPiModelOption(model)}`));

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
    if (hasProviderAuth(selectedProvider.provider, await createPiRuntime())) break;
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
    if (hasProviderAuth(selectedProvider.provider, await createPiRuntime())) {
      console.log(`Detected Pi auth for ${selectedProvider.provider}. Continuing bootstrap.`);
      break;
    }
    console.log(`Pi auth for ${selectedProvider.provider} is still missing after login.`);
  }

  return {
    config: buildBootstrapConfig({
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
