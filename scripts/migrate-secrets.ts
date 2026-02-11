#!/usr/bin/env bun
/**
 * Migrates API keys from .env to encrypted deepbase secrets
 */

import { getSecret, setSecret } from "../src/shared/db";
import { existsSync, readFileSync } from "fs";
import { config } from "../src/shared/config";

const ENV_PATH = `${config.tinyclawDir}/.env`;

async function migrateSecrets() {
  if (!existsSync(ENV_PATH)) {
    console.log("No .env file found, skipping migration");
    return;
  }

  const envContent = readFileSync(ENV_PATH, "utf-8");
  const lines = envContent.split("\n");

  const secretKeys = [
    "TELEGRAM_BOT_TOKEN",
    "OPENAI_API_KEY",
    "ELEVENLABS_API_KEY",
  ];

  let migrated = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const [key, ...valueParts] = trimmed.split("=");
    const value = valueParts.join("=").replace(/^["']|["']$/g, "");

    if (secretKeys.includes(key)) {
      const existing = await getSecret(key);
      if (!existing) {
        await setSecret(key, value);
        console.log(`✓ Migrated ${key}`);
        migrated++;
      } else {
        console.log(`- ${key} already exists in encrypted DB, skipping`);
      }
    }
  }

  console.log(`\nMigration complete: ${migrated} secrets migrated`);
  console.log(
    "\nIMPORTANT: You can now remove the API keys from .env file manually"
  );
}

migrateSecrets().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
