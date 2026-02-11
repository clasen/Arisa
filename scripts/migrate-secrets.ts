#!/usr/bin/env bun
/**
 * Migrate API keys from .env to encrypted secrets DB
 */

import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { setSecret } from "../src/shared/secrets";

const PROJECT_DIR = join(import.meta.dir, "..");
const ENV_PATH = join(PROJECT_DIR, ".tinyclaw", ".env");

async function main() {
  if (!existsSync(ENV_PATH)) {
    console.log("❌ No .env file found at", ENV_PATH);
    process.exit(1);
  }

  const content = readFileSync(ENV_PATH, "utf8");
  const secrets: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (match) {
      let value = match[2].trim();
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      secrets[match[1]] = value;
    }
  }

  const keysToMigrate = [
    "TELEGRAM_BOT_TOKEN",
    "OPENAI_API_KEY",
    "ELEVENLABS_API_KEY",
  ];

  console.log("🔐 Migrating secrets to encrypted DB...\n");

  for (const key of keysToMigrate) {
    if (secrets[key]) {
      await setSecret(key, secrets[key]);
      console.log(`✓ ${key}: migrated`);
    } else {
      console.log(`⚠ ${key}: not found in .env`);
    }
  }

  console.log("\n✅ Migration complete");
  console.log("📍 Secrets stored encrypted at: .tinyclaw/db/secrets.json");
  console.log("🔑 Encryption key stored at: .tinyclaw/.encryption_key");
  console.log("\n⚠️  Keep .env as fallback, but secrets DB takes precedence now");
}

main();
