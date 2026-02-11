/**
 * @module daemon/bridge
 * @role HTTP client from Daemon to Core with fallback to Claude CLI.
 * @responsibilities
 *   - POST messages to Core at :51777/message
 *   - If Core is down, retry once after 3s
 *   - If still down, fall back to direct Claude CLI invocation
 *   - Health check Core availability
 * @dependencies shared/config, shared/types, daemon/fallback, daemon/lifecycle
 * @effects Network (HTTP to Core), may spawn Claude CLI process
 * @contract sendToCore(msg, onStatus?) => Promise<CoreResponse>, isCoreHealthy() => Promise<boolean>
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import type { IncomingMessage, CoreResponse } from "../shared/types";
import { fallbackClaude } from "./fallback";
import { getCoreError } from "./lifecycle";

const log = createLogger("daemon");

const CORE_URL = `http://localhost:${config.corePort}`;
const RETRY_DELAY = 3000;

type StatusCallback = (text: string) => Promise<void>;

export async function sendToCore(
  message: IncomingMessage,
  onStatus?: StatusCallback,
): Promise<CoreResponse> {
  // First attempt
  try {
    return await postToCore(message);
  } catch {
    // Core unreachable — retry once after 3s
  }

  log.warn(`Core unreachable, retrying in ${RETRY_DELAY / 1000}s...`);
  await onStatus?.("Core no responde, reintentando...");
  await sleep(RETRY_DELAY);

  // Second attempt
  try {
    return await postToCore(message);
  } catch {
    // Still down — use fallback
  }

  log.warn("Core still unreachable, using fallback Claude CLI");
  const coreError = getCoreError();

  if (coreError) {
    const errorPreview = coreError.length > 300 ? coreError.slice(-300) : coreError;
    await onStatus?.(`Core sigue caido. Error:\n<pre>${escapeHtml(errorPreview)}</pre>\nConsultando a Claude directo...`);
  } else {
    await onStatus?.("Core sigue caido. Consultando a Claude directo...");
  }

  const text = message.text || "[non-text message — media not available in fallback mode]";
  const response = await fallbackClaude(text, coreError ?? undefined);

  return { text: response };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function postToCore(message: IncomingMessage): Promise<CoreResponse> {
  const response = await fetch(`${CORE_URL}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(config.claudeTimeout + 5000),
  });

  if (!response.ok) {
    throw new Error(`Core returned ${response.status}`);
  }

  return (await response.json()) as CoreResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function isCoreHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${CORE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}
