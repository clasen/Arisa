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
  queuePollIntervalMs: 250,
  streamBufferBytes: 1_048_576,
  ipcFrameBytes: 1_048_576
});

export const telegramConfigDefaults = Object.freeze({
  modelPickerPageSize: 8,
  busyMessageMode: "steer",
  ownerWorkspaceGroups: Object.freeze({})
});

export const doctorConfigDefaults = Object.freeze({
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

export const serviceConfigDefaults = Object.freeze({
  shutdownTimeoutMs: 15_000,
  shutdownPollIntervalMs: 100
});

export const piConfigDefaults = Object.freeze({
  thinkingLevel: "medium",
  speed: 1,
  compaction: Object.freeze({
    enabled: true,
    reserveTokens: 120_000,
    keepRecentTokens: 20_000
  })
});

function cloneChatModels(chatModels) {
  if (!chatModels || typeof chatModels !== "object") return chatModels;
  return Object.fromEntries(Object.entries(chatModels).map(([chatId, selection]) => [
    chatId,
    selection && typeof selection === "object" ? { ...selection } : selection
  ]));
}

export function applyConfigDefaults(config) {
  const normalized = { ...config };
  delete normalized.agent;
  delete normalized.prime;
  const configuredPi = normalized.pi || {};

  return {
    ...normalized,
    telegram: {
      ...telegramConfigDefaults,
      ...(config.telegram || {})
    },
    doctor: {
      ...doctorConfigDefaults,
      ...(config.doctor || {})
    },
    service: {
      ...serviceConfigDefaults,
      ...(config.service || {})
    },
    pi: {
      ...piConfigDefaults,
      ...configuredPi,
      compaction: {
        ...piConfigDefaults.compaction,
        ...(configuredPi.compaction || {})
      },
      chatModels: cloneChatModels(configuredPi.chatModels)
    },
    daemons: {
      ...daemonConfigDefaults,
      ...(config.daemons || {})
    }
  };
}
