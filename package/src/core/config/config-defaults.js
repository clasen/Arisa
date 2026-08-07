export const daemonConfigDefaults = Object.freeze({
  supervisorIntervalMs: 5_000,
  heartbeatIntervalMs: 5_000,
  heartbeatStaleMs: 20_000,
  healthIntervalMs: 30_000,
  healthTimeoutMs: 120_000,
  healthRetryLimit: 2,
  healthRetryBackoffMs: 1_000,
  restartLimit: 3,
  restartBackoffMs: 2_000,
  restartBackoffMaxMs: 60_000,
  startupTimeoutMs: 120_000,
  stopTimeoutMs: 3_000,
  queuePollIntervalMs: 250
});

export const telegramConfigDefaults = Object.freeze({
  modelPickerPageSize: 8
});

export const cliLogConfig = Object.freeze({
  recentLines: 100,
  followPollIntervalMs: 250
});

export const piConfigDefaults = Object.freeze({
  thinkingLevel: "medium"
});

export const primeConfigDefaults = Object.freeze({
  command: "",
  version: "0.7.0",
  thinkingLevel: "medium",
  idleMinutes: 90
});

function cloneChatModels(chatModels) {
  if (!chatModels || typeof chatModels !== "object") return chatModels;
  return Object.fromEntries(Object.entries(chatModels).map(([chatId, selection]) => [
    chatId,
    selection && typeof selection === "object" ? { ...selection } : selection
  ]));
}

export function applyConfigDefaults(config) {
  const legacyPi = config.pi || {};
  const configuredPrime = config.prime || {};
  return {
    ...config,
    agent: {
      runtime: "pi",
      ...(config.agent || {})
    },
    telegram: {
      ...telegramConfigDefaults,
      ...(config.telegram || {})
    },
    pi: {
      ...piConfigDefaults,
      ...legacyPi
    },
    prime: {
      ...primeConfigDefaults,
      provider: configuredPrime.provider ?? legacyPi.provider,
      model: configuredPrime.model ?? legacyPi.model,
      apiKey: configuredPrime.apiKey ?? legacyPi.apiKey,
      workspaceDir: configuredPrime.workspaceDir ?? legacyPi.workspaceDir,
      chatModels: cloneChatModels(configuredPrime.chatModels ?? legacyPi.chatModels),
      ...configuredPrime
    },
    daemons: {
      ...daemonConfigDefaults,
      ...(config.daemons || {})
    }
  };
}
