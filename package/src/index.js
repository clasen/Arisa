#!/usr/bin/env node

import { bootstrapIfNeeded } from "./runtime/bootstrap.js";
import { createApp } from "./runtime/create-app.js";
import { createLogger } from "./runtime/logger.js";
import { getServiceStatus, registerServiceProcess, startService, stopService, unregisterServiceProcess } from "./runtime/service-manager.js";
import { flushArisaHome } from "./runtime/flush.js";
import { arisaPackageDir } from "./runtime/paths.js";

process.env.ARISA_PACKAGE_DIR = arisaPackageDir;

const args = process.argv.slice(2);
const cli = parseCliArgs(args);
const command = cli.positionals[0] || "run";
const forceBootstrap = Boolean(cli.flags.bootstrap);
const verbose = !cli.flags.silent;
const serviceRunner = Boolean(cli.flags["service-runner"]);
const runtimeOverrides = toNestedOverrides(cli.nestedFlags);
const logger = createLogger({ verbose });
let activeApp = null;
let shuttingDown = false;

function parseCliArgs(rawArgs) {
  const flags = {};
  const nestedFlags = {};
  const positionals = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const flagName = token.slice(2);
    if (!flagName) continue;
    if (flagName.includes(".")) {
      const next = rawArgs[index + 1];
      const hasValue = typeof next === "string" && !next.startsWith("--");
      if (hasValue) {
        nestedFlags[flagName] = next;
        index += 1;
      }
      continue;
    }

    flags[flagName] = true;
  }

  return { flags, nestedFlags, positionals };
}

function toNestedOverrides(nestedFlags) {
  const overrides = {};
  for (const [flatKey, value] of Object.entries(nestedFlags)) {
    const parts = flatKey.split(".");
    let cursor = overrides;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index];
      if (!cursor[key] || typeof cursor[key] !== "object") {
        cursor[key] = {};
      }
      cursor = cursor[key];
    }
    cursor[parts[parts.length - 1]] = value;
  }
  return overrides;
}

function toServiceRunnerArgs(nestedFlags) {
  const args = [];
  const serviceSafePiFlags = [
    "pi.provider",
    "pi.model",
    "pi.workspaceDir",
    "pi.tools",
    "pi.excludeTools",
    "pi.shellPath",
    "pi.shellTimeoutMs"
  ];

  for (const flag of serviceSafePiFlags) {
    if (nestedFlags[flag]) {
      args.push(`--${flag}`, nestedFlags[flag]);
    }
  }
  return args;
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await activeApp?.stop?.();
  } catch (error) {
    logger.error("app", `shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = exitCode || 1;
  }
  if (serviceRunner) {
    await unregisterServiceProcess();
  }
  process.exit(exitCode);
}

process.once("SIGTERM", () => {
  shutdown(0);
});

process.once("SIGINT", () => {
  shutdown(0);
});

async function startRuntimeApp() {
  const app = await createApp({ logger, runtimeOverrides });
  activeApp = app;
  await app.start();
}

async function startBackgroundService() {
  const result = await startService({ verbose, cliArgs: toServiceRunnerArgs(cli.nestedFlags) });
  if (!result.ok) {
    console.log(`Arisa is already running in background (pid ${result.pid}).`);
    return result;
  }
  console.log(`Arisa started in background (pid ${result.pid}).`);
  console.log(`Log file: ${result.logFile}`);
  return result;
}

async function runForeground() {
  const hasRuntimePiOverrides = Boolean(
    runtimeOverrides?.pi?.model
    || runtimeOverrides?.pi?.provider
    || runtimeOverrides?.pi?.apiKey
    || runtimeOverrides?.pi?.workspaceDir
    || runtimeOverrides?.pi?.tools
    || runtimeOverrides?.pi?.excludeTools
    || runtimeOverrides?.pi?.shellPath
    || runtimeOverrides?.pi?.shellTimeoutMs
  );
  logger.log("app", `starting${verbose ? " in verbose mode" : ""}`);
  const bootstrapResult = await bootstrapIfNeeded({ force: forceBootstrap });
  if (bootstrapResult.startInBackground) {
    await startBackgroundService();
    return;
  }
  try {
    await startRuntimeApp();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No auth found")) {
      await activeApp?.stop?.();
      activeApp = null;
      console.log(`\n${message}\n`);
      if (hasRuntimePiOverrides) {
        console.log("Skipping automatic bootstrap because Pi runtime overrides were provided.");
        console.log("Keeping existing Telegram config. Run `arisa --bootstrap` manually if you want to update persisted auth/config.\n");
        throw error;
      }
      console.log("Reopening bootstrap so you can provide a Pi API key or switch to a provider you already authenticated with.\n");
      const retryBootstrapResult = await bootstrapIfNeeded({ force: true });
      if (retryBootstrapResult.startInBackground) {
        await startBackgroundService();
        return;
      }
      await startRuntimeApp();
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
    const bootstrapResult = await bootstrapIfNeeded({ force: forceBootstrap });
    if (bootstrapResult.configCreated && bootstrapResult.viaTelegram && !bootstrapResult.startInBackground) {
      console.log("Config saved. Arisa was not started in background.");
      return;
    }
    await startBackgroundService();
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

try {
  await main();
} catch (error) {
  logger.error("app", error instanceof Error ? error.message : String(error));
  await shutdown(1);
}
