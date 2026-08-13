import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { BOOTSTRAP_SECRET_PREFIX, createBootstrapSecret } from "./bootstrap-url.js";
import { readSecureJson, writeSecureJson } from "./secure-store.js";

export const DEFAULT_BOOTSTRAP_SECRET_TTL_MS = 10 * 60 * 1000;

function normalizeChatId(chatId) {
  const value = String(chatId ?? "").trim();
  if (!value) throw new Error("chatId is required for a bootstrap secret");
  return value;
}

function secretDigest(secret) {
  return createHash("sha256").update(String(secret), "utf8").digest();
}

function validateSecret(secret) {
  const value = String(secret || "");
  if (!value.startsWith(BOOTSTRAP_SECRET_PREFIX)) throw new Error("Bootstrap secret version is invalid");
  const encoded = value.slice(BOOTSTRAP_SECRET_PREFIX.length);
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== encoded) {
    throw new Error("Bootstrap secret must contain exactly 256 bits");
  }
  return value;
}

function activeRecords(records, nowMs) {
  return records.filter((record) => Date.parse(record.expiresAt) > nowMs);
}

export class PairingSecretStore {
  #operation = Promise.resolve();

  constructor({ file, ttlMs = DEFAULT_BOOTSTRAP_SECRET_TTL_MS, randomBytes, now = () => Date.now() }) {
    if (!file) throw new Error("Pairing secret store file is required");
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new Error("Pairing secret TTL must be a positive integer");
    this.file = file;
    this.ttlMs = ttlMs;
    this.randomBytes = randomBytes;
    this.now = now;
  }

  #serial(work) {
    const current = this.#operation.catch(() => {}).then(work);
    this.#operation = current;
    return current;
  }

  async #read() {
    const stored = await readSecureJson(this.file, { version: 1, records: [] });
    if (stored?.version !== 1 || !Array.isArray(stored.records)) throw new Error("Pairing secret store is invalid");
    return stored;
  }

  create({ chatId, endpoint }) {
    return this.#serial(async () => {
      const ownerChatId = normalizeChatId(chatId);
      const createdAtMs = this.now();
      const secret = createBootstrapSecret(this.randomBytes);
      const digest = secretDigest(secret);
      const stored = await this.#read();
      const records = activeRecords(stored.records, createdAtMs)
        .filter((record) => record.chatId !== ownerChatId);
      const record = {
        id: digest.subarray(0, 12).toString("base64url"),
        digest: digest.toString("base64"),
        secret,
        chatId: ownerChatId,
        endpoint: String(endpoint || ""),
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(createdAtMs + this.ttlMs).toISOString()
      };
      records.push(record);
      await writeSecureJson(this.file, { version: 1, records });
      return {
        secret,
        secretId: record.id,
        chatId: ownerChatId,
        endpoint: record.endpoint,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt
      };
    });
  }

  consume(secret, { chatId } = {}) {
    return this.#serial(async () => {
      const value = validateSecret(secret);
      const expectedChatId = chatId == null ? null : normalizeChatId(chatId);
      const nowMs = this.now();
      const digest = secretDigest(value);
      const stored = await this.#read();
      const current = activeRecords(stored.records, nowMs);
      const match = current.find((record) => {
        const candidate = Buffer.from(record.digest || "", "base64");
        return candidate.length === digest.length && timingSafeEqual(candidate, digest);
      });
      if (!match) {
        if (current.length !== stored.records.length) await writeSecureJson(this.file, { version: 1, records: current });
        throw new Error("Bootstrap secret is unknown, expired, rotated, or already consumed");
      }
      if (expectedChatId != null && match.chatId !== expectedChatId) {
        throw new Error("Bootstrap secret does not belong to this chat");
      }
      await writeSecureJson(this.file, {
        version: 1,
        records: current.filter((record) => record.id !== match.id)
      });
      return {
        secretId: match.id,
        chatId: match.chatId,
        endpoint: match.endpoint,
        createdAt: match.createdAt,
        expiresAt: match.expiresAt,
        consumedAt: new Date(nowMs).toISOString()
      };
    });
  }

  claim(secretId, { chatId } = {}) {
    return this.#serial(async () => {
      const id = String(secretId || "").trim();
      if (!id) throw new Error("secretId is required");
      const expectedChatId = chatId == null ? null : normalizeChatId(chatId);
      const nowMs = this.now();
      const stored = await this.#read();
      const records = activeRecords(stored.records, nowMs);
      const match = records.find((record) => record.id === id);
      if (!match) throw new Error("Bootstrap secret is unknown, expired, rotated, or already consumed");
      if (expectedChatId != null && match.chatId !== expectedChatId) {
        throw new Error("Bootstrap secret does not belong to this chat");
      }
      if (match.claimToken) throw new Error("Bootstrap secret already has an active pairing claim");
      const claimToken = randomUUID();
      const claimed = records.map((record) => record.id === id
        ? { ...record, claimToken, claimedAt: new Date(nowMs).toISOString() }
        : record);
      await writeSecureJson(this.file, { version: 1, records: claimed });
      return {
        secretId: match.id,
        secret: match.secret,
        claimToken,
        chatId: match.chatId,
        endpoint: match.endpoint,
        expiresAt: match.expiresAt
      };
    });
  }

  consumeClaim(secretId, claimToken) {
    return this.#serial(async () => {
      const id = String(secretId || "").trim();
      const token = String(claimToken || "").trim();
      if (!id || !token) throw new Error("secretId and claimToken are required");
      const stored = await this.#read();
      const records = activeRecords(stored.records, this.now());
      const match = records.find((record) => record.id === id && record.claimToken === token);
      if (!match) throw new Error("Pairing claim is unknown, expired, or already consumed");
      await writeSecureJson(this.file, { version: 1, records: records.filter((record) => record.id !== id) });
      return { secretId: match.id, chatId: match.chatId, endpoint: match.endpoint };
    });
  }

  releaseClaim(secretId, claimToken) {
    return this.#serial(async () => {
      const id = String(secretId || "").trim();
      const token = String(claimToken || "").trim();
      if (!id || !token) throw new Error("secretId and claimToken are required");
      const stored = await this.#read();
      let released = false;
      const records = activeRecords(stored.records, this.now()).map((record) => {
        if (record.id !== id || record.claimToken !== token) return record;
        released = true;
        const { claimToken: ignoredToken, claimedAt: ignoredAt, ...rest } = record;
        return rest;
      });
      if (released) await writeSecureJson(this.file, { version: 1, records });
      return { secretId: id, released };
    });
  }

  rotate(chatId) {
    return this.#serial(async () => {
      const ownerChatId = normalizeChatId(chatId);
      const stored = await this.#read();
      const records = activeRecords(stored.records, this.now()).filter((record) => record.chatId !== ownerChatId);
      const removed = stored.records.length - records.length;
      await writeSecureJson(this.file, { version: 1, records });
      return { chatId: ownerChatId, removed };
    });
  }

  list({ chatId } = {}) {
    return this.#serial(async () => {
      const stored = await this.#read();
      const records = activeRecords(stored.records, this.now());
      if (records.length !== stored.records.length) await writeSecureJson(this.file, { version: 1, records });
      const ownerChatId = chatId == null ? null : normalizeChatId(chatId);
      return records
        .filter((record) => ownerChatId == null || record.chatId === ownerChatId)
        .map(({ digest, secret, claimToken, ...record }) => ({ ...record, claimed: Boolean(claimToken) }));
    });
  }
}
