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

export const doctorConfigDefaults = Object.freeze({
  contextInspectionTimeoutMs: 5_000,
  primeShutdownTimeoutMs: 15_000,
  contextWarningPercent: 70,
  contextCriticalPercent: 90,
  contextInefficientMinTokens: 32_000,
  contextToolResultWarningPercent: 60,
  contextSingleMessageWarningPercent: 50
});

export const cliLogConfig = Object.freeze({
  recentLines: 100,
  followPollIntervalMs: 250
});

export const agentConfigDefaults = Object.freeze({
  runtime: "pi"
});

export const piConfigDefaults = Object.freeze({
  thinkingLevel: "medium"
});

export const defaultPrimeVersion = "0.7.1";

export const primeConfigDefaults = Object.freeze({
  command: "",
  version: defaultPrimeVersion,
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
  const prime = {
    ...primeConfigDefaults,
    provider: configuredPrime.provider ?? legacyPi.provider,
    model: configuredPrime.model ?? legacyPi.model,
    apiKey: configuredPrime.apiKey ?? legacyPi.apiKey,
    workspaceDir: configuredPrime.workspaceDir ?? legacyPi.workspaceDir,
    chatModels: cloneChatModels(configuredPrime.chatModels ?? legacyPi.chatModels),
    ...configuredPrime
  };
  if (!String(prime.command || "").trim()) prime.version = defaultPrimeVersion;

  return {
    ...config,
    agent: {
      ...agentConfigDefaults,
      ...(config.agent || {})
    },
    telegram: {
      ...telegramConfigDefaults,
      ...(config.telegram || {})
    },
    doctor: {
      ...doctorConfigDefaults,
      ...(config.doctor || {})
    },
    pi: {
      ...piConfigDefaults,
      ...legacyPi
    },
    prime,
    daemons: {
      ...daemonConfigDefaults,
      ...(config.daemons || {})
    }
  };
}
