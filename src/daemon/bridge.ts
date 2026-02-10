/**
 * @module daemon/bridge
 * @role HTTP client from Daemon to Core with retry + in-memory queue.
 * @responsibilities
 *   - POST messages to Core at :7777/message
 *   - Queue messages in memory if Core is down
 *   - Retry queued messages every 2s up to 60s
 *   - Health check Core availability
 * @dependencies shared/config, shared/types
 * @effects Network (HTTP to Core)
 * @contract sendToCore(msg) => Promise<CoreResponse>, isHealthy() => Promise<boolean>
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import type { IncomingMessage, CoreResponse } from "../shared/types";

const log = createLogger("daemon");

const CORE_URL = `http://localhost:${config.corePort}`;
const RETRY_INTERVAL = 2000;
const MAX_RETRY_TIME = 60_000;

interface QueuedMessage {
  message: IncomingMessage;
  resolve: (response: CoreResponse) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

const queue: QueuedMessage[] = [];
let retryTimer: ReturnType<typeof setInterval> | null = null;

export async function sendToCore(message: IncomingMessage): Promise<CoreResponse> {
  try {
    return await postToCore(message);
  } catch (error) {
    log.warn(`Core unreachable, queueing message from ${message.sender}`);
    return new Promise((resolve, reject) => {
      queue.push({ message, resolve, reject, enqueuedAt: Date.now() });
      startRetryLoop();
    });
  }
}

async function postToCore(message: IncomingMessage): Promise<CoreResponse> {
  const response = await fetch(`${CORE_URL}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    throw new Error(`Core returned ${response.status}`);
  }

  return (await response.json()) as CoreResponse;
}

function startRetryLoop() {
  if (retryTimer) return;
  retryTimer = setInterval(async () => {
    if (queue.length === 0) {
      if (retryTimer) clearInterval(retryTimer);
      retryTimer = null;
      return;
    }

    // Expire messages older than MAX_RETRY_TIME
    const now = Date.now();
    while (queue.length > 0 && now - queue[0].enqueuedAt > MAX_RETRY_TIME) {
      const expired = queue.shift()!;
      expired.reject(new Error("Core unavailable after 60s timeout"));
      log.error(`Message from ${expired.message.sender} expired after 60s`);
    }

    if (queue.length === 0) {
      if (retryTimer) clearInterval(retryTimer);
      retryTimer = null;
      return;
    }

    // Try to process the first queued message
    const item = queue[0];
    try {
      const response = await postToCore(item.message);
      queue.shift();
      item.resolve(response);
      log.info(`Queued message from ${item.message.sender} processed successfully`);
    } catch {
      log.debug(`Core still unreachable, ${queue.length} message(s) queued`);
    }
  }, RETRY_INTERVAL);
}

export async function isCoreHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${CORE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}
