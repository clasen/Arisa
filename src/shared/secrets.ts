/**
 * @module shared/secrets
 * @role Encrypted secrets storage using DeepbaseSecure
 * @responsibilities
 *   - Generate/load encryption key
 *   - Store API keys encrypted at rest
 *   - Provide type-safe getters for secrets
 * @dependencies DeepbaseSecure, crypto-js
 */

import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import CryptoJS from "crypto-js";
import { DeepbaseSecure } from "./deepbase-secure";
import { dataDir } from "./paths";

const ARISA_DIR = dataDir;
const ENCRYPTION_KEY_PATH = join(ARISA_DIR, ".encryption_key");
const SECRETS_DB_PATH = join(ARISA_DIR, "db");

// Ensure runtime data and db dirs exist
mkdirSync(join(ARISA_DIR, "db"), { recursive: true });

/**
 * Load or generate encryption key
 */
function getEncryptionKey(): string {
  if (existsSync(ENCRYPTION_KEY_PATH)) {
    return readFileSync(ENCRYPTION_KEY_PATH, "utf8").trim();
  }

  // Generate random 256-bit key
  const key = CryptoJS.lib.WordArray.random(256 / 8).toString(CryptoJS.enc.Hex);
  writeFileSync(ENCRYPTION_KEY_PATH, key, { mode: 0o600 });
  return key;
}

const encryptionKey = getEncryptionKey();
const secretsDb = new DeepbaseSecure({
  path: SECRETS_DB_PATH,
  name: "secrets",
  encryptionKey,
});

// Initialize connection
let connectionPromise: Promise<void> | null = null;
async function ensureConnected(): Promise<void> {
  if (!connectionPromise) {
    connectionPromise = secretsDb.connect();
  }
  await connectionPromise;
}

/**
 * Get a secret by key
 */
export async function getSecret(key: string): Promise<string | undefined> {
  await ensureConnected();
  return await secretsDb.get("secrets", key);
}

/**
 * Set a secret by key
 */
export async function setSecret(key: string, value: string): Promise<void> {
  await ensureConnected();
  await secretsDb.set("secrets", key, value);
}

/**
 * Delete a secret by key
 */
export async function deleteSecret(key: string): Promise<void> {
  await ensureConnected();
  await secretsDb.del("secrets", key);
}

/**
 * Type-safe getters for known secrets
 */
export const secrets = {
  telegram: () => getSecret("TELEGRAM_BOT_TOKEN"),
  openai: () => getSecret("OPENAI_API_KEY"),
  elevenlabs: () => getSecret("ELEVENLABS_API_KEY"),
};
