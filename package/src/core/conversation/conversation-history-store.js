import crypto from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getChatConversationHistoryFile } from "../../runtime/paths.js";

const utf8Bom = "\uFEFF";

function normalizeText(value) {
  return String(value || "").trim();
}

function parseHistory(contents) {
  return String(contents || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function serializeRecord(record) {
  return `${JSON.stringify(record)}\n`;
}

export function formatPortableConversation(records) {
  if (!records.length) return "";
  const sections = [
    "Portable Arisa conversation history.",
    "This history belongs to the same Telegram chat and was preserved while changing agent harnesses.",
    "Use it as prior conversation context. Do not repeat it unless the user asks."
  ];

  for (const record of records) {
    if (record.kind === "seed") {
      sections.push(`Imported earlier conversation:\n${record.history}`);
      continue;
    }
    const parts = [];
    if (record.prompt) parts.push(`User or system request:\n${record.prompt}`);
    if (record.response) parts.push(`Assistant response:\n${record.response}`);
    if (parts.length) sections.push(parts.join("\n\n"));
  }
  return sections.join("\n\n---\n\n");
}

export class ConversationHistoryStore {
  constructor({ historyFile = getChatConversationHistoryFile } = {}) {
    this.locks = new Map();
    this.historyFile = historyFile;
  }

  async withChatLock(chatId, work) {
    const key = String(chatId);
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async read(chatId) {
    try {
      return parseHistory(await readFile(this.historyFile(chatId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async hasEntries(chatId) {
    return (await this.read(chatId)).length > 0;
  }

  async appendRecord(chatId, record) {
    const file = this.historyFile(chatId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(file, "a+", 0o600);
    try {
      const stats = await handle.stat();
      if (stats.size === 0) await handle.write(utf8Bom);
      await handle.write(serializeRecord(record));
    } finally {
      await handle.close();
    }
  }

  async ensureSeed(chatId, { runtime, history }) {
    const normalizedHistory = normalizeText(history);
    if (!normalizedHistory) return false;
    return this.withChatLock(chatId, async () => {
      if ((await this.read(chatId)).length) return false;
      await this.appendRecord(chatId, {
        id: crypto.randomUUID(),
        kind: "seed",
        runtime,
        history: normalizedHistory,
        createdAt: new Date().toISOString()
      });
      return true;
    });
  }

  async appendTurn(chatId, { runtime, prompt, response }) {
    const normalizedPrompt = normalizeText(prompt);
    const normalizedResponse = normalizeText(response);
    if (!normalizedPrompt && !normalizedResponse) return null;
    const record = {
      id: crypto.randomUUID(),
      kind: "turn",
      runtime,
      prompt: normalizedPrompt,
      response: normalizedResponse,
      createdAt: new Date().toISOString()
    };
    await this.withChatLock(chatId, () => this.appendRecord(chatId, record));
    return record;
  }

  async reset(chatId, { runtime, history = "" } = {}) {
    return this.withChatLock(chatId, async () => {
      const file = this.historyFile(chatId);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const normalizedHistory = normalizeText(history);
      const seed = normalizedHistory
        ? serializeRecord({
            id: crypto.randomUUID(),
            kind: "seed",
            runtime,
            history: normalizedHistory,
            createdAt: new Date().toISOString()
          })
        : "";
      await writeFile(file, `${utf8Bom}${seed}`, { encoding: "utf8", mode: 0o600 });
    });
  }

  async buildHandoff(chatId) {
    return formatPortableConversation(await this.read(chatId));
  }
}
