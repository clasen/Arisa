/**
 * @module core/history
 * @role Shared conversation history across backends (Claude/Codex).
 * @responsibilities
 *   - Log each user↔backend exchange with backend tag
 *   - Provide "foreign" context: exchanges from the OTHER backend
 *     that the current backend hasn't seen
 *   - Persist to disk, load on startup
 * @dependencies shared/config
 * @effects Reads/writes .tinyclaw/history.jsonl
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { config } from "../shared/config";
import { createLogger } from "../shared/logger";

const log = createLogger("core");

const HISTORY_PATH = join(config.tinyclawDir, "history.jsonl");
const MAX_ENTRIES_PER_CHAT = 50;

interface Exchange {
  ts: number;
  chatId: string;
  user: string;
  response: string;
  backend: "claude" | "codex";
}

let history: Exchange[] = [];

// Load persisted history on import
try {
  if (existsSync(HISTORY_PATH)) {
    const lines = readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean);
    history = lines.map((l) => JSON.parse(l));
    log.info(`Loaded ${history.length} history entries`);
  }
} catch (e) {
  log.warn(`Failed to load history: ${e}`);
}

export function addExchange(
  chatId: string,
  user: string,
  response: string,
  backend: "claude" | "codex",
) {
  const entry: Exchange = { ts: Date.now(), chatId, user, response, backend };
  history.push(entry);

  // Prune old entries per chat
  const chatEntries = history.filter((e) => e.chatId === chatId);
  if (chatEntries.length > MAX_ENTRIES_PER_CHAT) {
    const toRemove = chatEntries.length - MAX_ENTRIES_PER_CHAT;
    let removed = 0;
    history = history.filter((e) => {
      if (e.chatId === chatId && removed < toRemove) {
        removed++;
        return false;
      }
      return true;
    });
  }

  // Persist
  try {
    const dir = dirname(HISTORY_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Rewrite full file after prune to keep it clean
    writeFileSync(HISTORY_PATH, history.map((e) => JSON.stringify(e)).join("\n") + "\n");
  } catch (e) {
    log.warn(`Failed to persist history: ${e}`);
  }
}

/**
 * Returns context string with exchanges from the OTHER backend
 * that happened since the current backend was last used.
 * Returns empty string if there's nothing to inject.
 */
export function getForeignContext(
  chatId: string,
  currentBackend: "claude" | "codex",
  limit = 10,
): string {
  const chatHistory = history.filter((e) => e.chatId === chatId);
  if (chatHistory.length === 0) return "";

  // Find last exchange handled by current backend
  let lastOwnIdx = -1;
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    if (chatHistory[i].backend === currentBackend) {
      lastOwnIdx = i;
      break;
    }
  }

  // Get foreign exchanges since then
  const foreign = chatHistory
    .slice(lastOwnIdx + 1)
    .filter((e) => e.backend !== currentBackend);

  if (foreign.length === 0) return "";

  const otherName = currentBackend === "claude" ? "Codex" : "Claude";
  const lines = foreign
    .slice(-limit)
    .map((e) => `User: ${e.user}\n${otherName}: ${e.response}`)
    .join("\n\n");

  return `[Contexto previo con ${otherName}]\n${lines}\n[Fin del contexto previo]\n\n`;
}
