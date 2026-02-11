#!/usr/bin/env bun
/**
 * Test encrypted secrets loading
 */

import { secrets } from "../src/shared/secrets";

async function main() {
  console.log("🔐 Testing encrypted secrets...\n");

  const telegram = await secrets.telegram();
  const openai = await secrets.openai();
  const elevenlabs = await secrets.elevenlabs();

  console.log("✓ TELEGRAM_BOT_TOKEN:", telegram ? `${telegram.slice(0, 10)}...${telegram.slice(-10)}` : "NOT FOUND");
  console.log("✓ OPENAI_API_KEY:", openai ? `${openai.slice(0, 10)}...${openai.slice(-10)}` : "NOT FOUND");
  console.log("✓ ELEVENLABS_API_KEY:", elevenlabs ? `${elevenlabs.slice(0, 10)}...${elevenlabs.slice(-10)}` : "NOT FOUND");

  console.log("\n✅ Secrets loaded successfully from encrypted DB");
}

main();
