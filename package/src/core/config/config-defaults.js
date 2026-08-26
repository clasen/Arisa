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

export const toolExecutionConfigDefaults = Object.freeze({
  defaultCapacity: 2,
  maxQueuedPerClass: 100,
  minAvailableMemoryMb: 128,
  maxWorkerRssMb: 384,
  maxSwapUsedPercent: 95,
  capacities: Object.freeze({ browser: 1, orchestrator: 1 })
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
  shutdownPollIntervalMs: 100,
  workerRestartLimit: 3,
  workerRestartBackoffMs: 2_000,
  workerRestartBackoffMaxMs: 60_000,
  workerStableRuntimeMs: 60_000
});

export const taskConfigDefaults = Object.freeze({
  agentTimeoutMs: 15 * 60_000,
  eventTimeoutMs: 5 * 60_000
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
    toolExecution: {
      ...toolExecutionConfigDefaults,
      ...(config.toolExecution || {}),
      capacities: {
        ...toolExecutionConfigDefaults.capacities,
        ...(config.toolExecution?.capacities || {})
      }
    },
    doctor: {
      ...doctorConfigDefaults,
      ...(config.doctor || {})
    },
    service: {
      ...serviceConfigDefaults,
      ...(config.service || {})
    },
    tasks: {
      ...taskConfigDefaults,
      ...(config.tasks || {})
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
