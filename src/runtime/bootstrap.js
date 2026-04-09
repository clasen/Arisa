import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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

function startAuthRelay(port) {
  let authUrl = "";
  let resolveRedirectUrl;
  const redirectUrlPromise = new Promise((resolve) => {
    resolveRedirectUrl = resolve;
  });

  const page = (body) => [
    "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width'>",
    "<title>Arisa Auth</title>",
    "<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:40px auto;padding:0 20px;line-height:1.6}",
    "input[type=text]{width:100%;padding:8px;box-sizing:border-box;margin:8px 0}",
    "button{padding:8px 24px;cursor:pointer}code{background:#f0f0f0;padding:2px 6px;border-radius:3px}</style>",
    "</head><body>",
    body,
    "</body></html>"
  ].join("");

  const server = createServer((req, res) => {
    const parsed = new URL(req.url, `http://localhost:${port}`);

    if (req.method === "GET" && parsed.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page([
        "<h2>Arisa &mdash; Pi Authentication</h2>",
        authUrl
          ? `<p><strong>1.</strong> <a href="${authUrl}" target="_blank">Click here to log in with Pi</a></p>`
          : "<p>Waiting for authentication URL&hellip;</p>",
        "<p><strong>2.</strong> After login your browser will redirect to a <code>localhost</code> URL that won't load. That's expected.</p>",
        "<p><strong>3.</strong> Copy the full URL from your browser's address bar and paste it below:</p>",
        '<form method="POST" action="/auth/relay">',
        '<input type="text" name="url" placeholder="Paste the localhost redirect URL here&hellip;" required />',
        "<button type='submit'>Submit</button>",
        "</form>"
      ].join("\n")));
      return;
    }

    if (req.method === "POST" && parsed.pathname === "/auth/relay") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const url = (new URLSearchParams(body).get("url") || "").trim();
        if (url) resolveRedirectUrl(url);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("<h2>Authentication received</h2><p>You can close this page. Arisa is starting&hellip;</p>"));
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({
        setAuthUrl(url) { authUrl = url; },
        waitForRedirectUrl() { return redirectUrlPromise; },
        close() { return new Promise((r) => server.close(r)); }
      });
    });
  });
}

async function runInternalPiLogin(provider, { rl = null, authRelay = null } = {}) {
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
      if (authRelay) {
        authRelay.setAuthUrl(url);
        console.log("Waiting for authentication via the web relay...");
        const redirectUrl = await authRelay.waitForRedirectUrl();
        if (redirectUrl && manualCodeResolve) {
          manualCodeResolve(redirectUrl);
          manualCodeResolve = undefined;
        }
      } else if (selected.usesCallbackServer && rl) {
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
    const piApiKey = normalizeString(cliConfigOverrides?.pi?.apiKey);
    if (!piApiKey && !hasProviderAuth(resolvedPi.provider, runtime)) {
      if (!supportsProviderOAuth(resolvedPi.provider, runtime)) {
        throw new Error(
          `No auth found for ${resolvedPi.provider}. Provide --pi.apiKey for non-interactive bootstrap, or use a provider that supports OAuth.`
        );
      }
      const relayPort = Number(process.env.PORT) || 10000;
      const authRelay = await startAuthRelay(relayPort);
      console.log(`No existing Pi auth found for ${resolvedPi.provider}. Starting auth relay on port ${relayPort}.`);
      console.log(`Open your server URL in a browser to complete Pi authentication.\n`);
      try {
        await runInternalPiLogin(resolvedPi.provider, { authRelay });
      } finally {
        await authRelay.close();
      }
      if (!hasProviderAuth(resolvedPi.provider, createPiRuntime())) {
        throw new Error(
          `Pi login did not complete for ${resolvedPi.provider}. Retry or provide --pi.apiKey.`
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
