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

export function findPiModel({ provider, model, apiKey } = {}) {
  const runtime = createPiRuntime({ provider, apiKey });
  return {
    ...runtime,
    model: provider && model ? runtime.modelRegistry.find(provider, model) : null
  };
}
