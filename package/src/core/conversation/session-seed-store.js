import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getChatLegacyConversationHistoryFile,
  getChatSessionSeedFile
} from "../../runtime/paths.js";

function parseRecords(contents) {
  return String(contents || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function seedText(record) {
  return String(record?.context || record?.history || "").trim();
}

export class SessionSeedStore {
  constructor({
    seedFile = getChatSessionSeedFile,
    legacyFile = getChatLegacyConversationHistoryFile
  } = {}) {
    this.seedFile = seedFile;
    this.legacyFile = legacyFile;
    this.locks = new Map();
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

  async write(chatId, record = null) {
    const file = this.seedFile(chatId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const body = record ? `${JSON.stringify(record)}\n` : "";
    await writeFile(file, body, { encoding: "utf8", mode: 0o600 });
  }

  async set(chatId, context) {
    const normalized = String(context || "").trim();
    return this.withChatLock(chatId, async () => {
      await this.write(chatId, normalized ? { kind: "seed", context: normalized } : null);
      return Boolean(normalized);
    });
  }

  async clear(chatId) {
    return this.withChatLock(chatId, () => this.write(chatId));
  }

  async readPendingRecords(chatId) {
    try {
      return parseRecords(await readFile(this.seedFile(chatId), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      return parseRecords(await readFile(this.legacyFile(chatId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async consume(chatId) {
    return this.withChatLock(chatId, async () => {
      const records = await this.readPendingRecords(chatId);
      const pendingSeed = records.length === 1 && records[0]?.kind === "seed"
        ? seedText(records[0])
        : "";
      await this.write(chatId);
      return pendingSeed;
    });
  }
}
