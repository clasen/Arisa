import { applyConfigDefaults } from "../core/config/config-defaults.js";

export function buildBootstrapConfig({
  telegramApiKey,
  telegramMaxChatIds,
  authorizedChatIds = [],
  chatMeta = {},
  provider,
  model,
  piApiKey
}) {
  return applyConfigDefaults({
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
  });
}

export function sortBootstrapProviders(providers) {
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

export function sortBootstrapModels(provider, models) {
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

export function parsePositiveInteger(value, fallback = null) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

export function selectByIndex(items, value, fallbackIndex = 0) {
  const index = parsePositiveInteger(value, fallbackIndex + 1) - 1;
  return items[Math.max(0, Math.min(items.length - 1, index))];
}

export function parseYesNo(value, fallback = true) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["y", "yes", "s", "si", "sí"].includes(text)) return true;
  if (["n", "no"].includes(text)) return false;
  return null;
}

export function getIncomingChatMeta(ctx) {
  return {
    languageCode: ctx.from?.language_code || "",
    username: ctx.from?.username || "",
    firstName: ctx.from?.first_name || "",
    lastName: ctx.from?.last_name || ""
  };
}

export function formatProviderOption(item) {
  const authLabel = item.authConfigured ? "auth configured" : item.supportsOAuth ? "login or API key" : "API key";
  return `${item.provider} (${item.modelCount} models, ${authLabel})`;
}

export function selectPiLoginOption(options = []) {
  return options.find((option) => /device/i.test(`${option.id} ${option.label}`))
    || options.find((option) => /browser|oauth|web/i.test(`${option.id} ${option.label}`))
    || options[0]
    || null;
}
