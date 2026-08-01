import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { piAuthFile } from "../../runtime/paths.js";

function compareText(a, b) {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

export function createPiRuntime({ provider, apiKey } = {}) {
  const authStorage = AuthStorage.create(piAuthFile);
  if (provider && apiKey) {
    authStorage.setRuntimeApiKey(provider, apiKey);
  }
  const modelRegistry = ModelRegistry.create(authStorage);
  const oauthProviders = authStorage.getOAuthProviders();
  return { authStorage, modelRegistry, oauthProviders };
}

export function hasProviderAuth(provider, { authStorage, modelRegistry }) {
  return modelRegistry.hasConfiguredAuth(provider) || authStorage.hasAuth(provider);
}

export function supportsProviderOAuth(provider, { oauthProviders }) {
  return oauthProviders.some((item) => item.id === provider);
}

export function listPiProviders(runtime = createPiRuntime()) {
  const { modelRegistry, oauthProviders } = runtime;
  const allModels = modelRegistry.getAll();
  const oauthIds = new Set(oauthProviders.map((item) => item.id));
  const counts = new Map();
  for (const model of allModels) {
    counts.set(model.provider, (counts.get(model.provider) || 0) + 1);
  }

  return [...counts.keys()]
    .map((provider) => ({
      provider,
      authConfigured: hasProviderAuth(provider, runtime),
      supportsOAuth: oauthIds.has(provider),
      modelCount: counts.get(provider) || 0
    }))
    .sort((a, b) => {
      if (a.authConfigured !== b.authConfigured) return a.authConfigured ? -1 : 1;
      if (a.supportsOAuth !== b.supportsOAuth) return a.supportsOAuth ? -1 : 1;
      return compareText(a.provider, b.provider);
    });
}

export function listProviderModels(provider, runtime = createPiRuntime()) {
  return runtime.modelRegistry
    .getAll()
    .filter((model) => model.provider === provider)
    .sort((a, b) => compareText(a.name || a.id, b.name || b.id));
}

export function formatPiModelOption(model) {
  const capabilities = [
    model.reasoning ? "reasoning" : null,
    model.input?.includes("image") ? "image" : null
  ].filter(Boolean).join(", ");
  return capabilities ? `${model.id} [${capabilities}]` : model.id;
}

/** Mirrors @earendil-works/pi-ai getSupportedThinkingLevels for the active model. */
const EXTENDED_THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

export function listModelThinkingLevels(model) {
  if (!model?.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function clampModelThinkingLevel(model, level) {
  const availableLevels = listModelThinkingLevels(model);
  if (availableLevels.includes(level)) return level;
  const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) return availableLevels[0] ?? "off";
  for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) return candidate;
  }
  return availableLevels[0] ?? "off";
}

export function modelSupportsThinking(model) {
  return listModelThinkingLevels(model).some((level) => level !== "off");
}

export function findPiModel({ provider, model, apiKey } = {}) {
  const runtime = createPiRuntime({ provider, apiKey });
  return {
    ...runtime,
    model: provider && model ? runtime.modelRegistry.find(provider, model) : null
  };
}
