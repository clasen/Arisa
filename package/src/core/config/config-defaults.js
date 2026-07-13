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

export function applyConfigDefaults(config) {
  return {
    ...config,
    daemons: {
      ...daemonConfigDefaults,
      ...(config.daemons || {})
    }
  };
}
