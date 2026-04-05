#!/usr/bin/env node

import { bootstrapIfNeeded } from "./runtime/bootstrap.js";
import { createApp } from "./runtime/create-app.js";
import { createLogger } from "./runtime/logger.js";

const forceBootstrap = process.argv.includes("--bootstrap");
const verbose = process.argv.includes("--verbose");
const logger = createLogger({ verbose });

async function main() {
  logger.log("app", `starting${verbose ? " in verbose mode" : ""}`);
  await bootstrapIfNeeded({ force: forceBootstrap });
  try {
    const app = await createApp({ logger });
    await app.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No auth found")) {
      console.log(`\n${message}\n`);
      console.log("Reopening bootstrap so you can provide a Pi API key or switch to a provider you already authenticated with.\n");
      await bootstrapIfNeeded({ force: true });
      const app = await createApp({ logger });
      await app.start();
      return;
    }
    throw error;
  }
}

await main();
