/**
 * @module core/onboarding
 * @role First-message onboarding: check CLIs and API keys, guide the user.
 * @responsibilities
 *   - Detect installed CLIs (claude, codex) via Bun.which
 *   - Check OPENAI_API_KEY config
 *   - Track onboarded chats in .tinyclaw/onboarded.json
 *   - Build platform-specific install instructions
 * @dependencies shared/config
 * @effects Reads/writes .tinyclaw/onboarded.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { config } from "../shared/config";
import { createLogger } from "../shared/logger";

const log = createLogger("core");
const ONBOARDED_PATH = join(config.tinyclawDir, "onboarded.json");

let onboardedChats: Set<string> = new Set();

try {
  if (existsSync(ONBOARDED_PATH)) {
    onboardedChats = new Set(JSON.parse(readFileSync(ONBOARDED_PATH, "utf8")));
  }
} catch {
  // Fresh start
}

function save() {
  try {
    const dir = dirname(ONBOARDED_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(ONBOARDED_PATH, JSON.stringify([...onboardedChats]));
  } catch (e) {
    log.warn(`Failed to save onboarded state: ${e}`);
  }
}

export interface DepsStatus {
  claude: boolean;
  codex: boolean;
  openaiKey: boolean;
  os: string;
}

export function checkDeps(): DepsStatus {
  const os =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "Windows"
        : "Linux";

  return {
    claude: Bun.which("claude") !== null,
    codex: Bun.which("codex") !== null,
    openaiKey: !!config.openaiApiKey,
    os,
  };
}

export function isOnboarded(chatId: string): boolean {
  return onboardedChats.has(chatId);
}

export function markOnboarded(chatId: string) {
  onboardedChats.add(chatId);
  save();
}

/**
 * Returns onboarding message for first-time users, or null if everything is set up.
 * Only blocks if NO CLI is available at all.
 */
export function getOnboarding(chatId: string): { message: string; blocking: boolean } | null {
  if (isOnboarded(chatId)) return null;

  const deps = checkDeps();

  // Everything set up — skip onboarding
  if (deps.claude && deps.codex && deps.openaiKey) {
    markOnboarded(chatId);
    return null;
  }

  // No CLI at all — block
  if (!deps.claude && !deps.codex) {
    const lines = [
      "<b>Bienvenido a TinyClaw!</b>\n",
      "No encontré ni Claude CLI ni Codex CLI. Necesitás al menos uno.\n",
    ];
    if (deps.os === "macOS") {
      lines.push("Claude: <code>brew install claude-code</code>");
    } else {
      lines.push("Claude: <code>npm install -g @anthropic-ai/claude-code</code>");
    }
    lines.push("Codex: <code>npm install -g @openai/codex</code>\n");
    lines.push("Instalá uno y volvé a escribirme.");
    return { message: lines.join("\n"), blocking: true };
  }

  // At least one CLI — inform and continue
  markOnboarded(chatId);

  const using = deps.claude ? "Claude" : "Codex";
  const lines = [`<b>TinyClaw</b> — usando <b>${using}</b>`];

  if (!deps.claude) {
    lines.push("Claude CLI no instalado. Podés agregarlo con <code>npm install -g @anthropic-ai/claude-code</code>");
  } else if (!deps.codex) {
    lines.push("Codex CLI no instalado. Podés agregarlo con <code>npm install -g @openai/codex</code>");
  } else {
    lines.push("Usá /codex o /claude para cambiar de backend.");
  }

  if (!deps.openaiKey) {
    lines.push("Sin OpenAI API key — audios e imágenes deshabilitados. Agregá <code>OPENAI_API_KEY</code> en <code>.tinyclaw/.env</code> si los querés.");
  }

  return { message: lines.join("\n"), blocking: false };
}
