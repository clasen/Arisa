#!/usr/bin/env node

import { bootstrapIfNeeded } from "./runtime/bootstrap.js";
import { createApp } from "./runtime/create-app.js";
import { createLogger } from "./runtime/logger.js";
import { getServiceStatus, registerServiceProcess, startService, stopService } from "./runtime/service-manager.js";
import { flushArisaHome } from "./runtime/flush.js";

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith("--")) || "run";
const forceBootstrap = args.includes("--bootstrap");
const verbose = args.includes("--verbose");
const serviceRunner = args.includes("--service-runner");
const logger = createLogger({ verbose });

async function runForeground() {
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

async function main() {
  if (serviceRunner) {
    await registerServiceProcess();
    await runForeground();
    return;
  }

  if (command === "start") {
    await bootstrapIfNeeded({ force: forceBootstrap });
    const result = await startService({ verbose });
    if (!result.ok) {
      console.log(`Arisa is already running in background (pid ${result.pid}).`);
      return;
    }
    console.log(`Arisa started in background (pid ${result.pid}).`);
    console.log(`Log file: ${result.logFile}`);
    return;
  }

  if (command === "stop") {
    const result = await stopService();
    if (!result.ok) {
      console.log("Arisa is not running.");
      return;
    }
    console.log(`Arisa stopped (pid ${result.pid}).`);
    return;
  }

  if (command === "status") {
    const status = await getServiceStatus();
    if (!status.running) {
      console.log("Arisa is not running.");
      return;
    }
    console.log(`Arisa is running in background (pid ${status.pid}).`);
    return;
  }

  if (command === "flush") {
    const status = await getServiceStatus();
    if (status.running) {
      console.log(`Arisa is running (pid ${status.pid}). Stop it before flush.`);
      return;
    }
    const result = await flushArisaHome();
    console.log(`Arisa state removed: ${result.path}`);
    return;
  }

  await runForeground();
}

await main();
