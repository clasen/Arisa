import { loadConfig } from "../config/config-store.js";

export async function loadDaemonPolicy() {
  const config = await loadConfig();
  return config.daemons;
}

export function retryDelay(attempt, { restartBackoffMs, restartBackoffMaxMs }) {
  return Math.min(restartBackoffMaxMs, restartBackoffMs * (2 ** Math.max(0, attempt - 1)));
}
