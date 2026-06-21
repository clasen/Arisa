#!/usr/bin/env node

import { createServer } from "node:http";
import { execFile } from "node:child_process";
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
const verbose = Boolean(cli.flags.verbose);
const serviceRunner = Boolean(cli.flags["service-runner"]);
const bootstrapOverrides = toBootstrapOverrides(cli.nestedFlags);
const runtimeOverrides = toRuntimeOverrides(cli.nestedFlags);
const logger = createLogger({ verbose });
let activeApp = null;
let shuttingDown = false;

const defaultHttpPort = 11970;
const httpPort = Number(process.env.ARISA_HTTP_PORT || defaultHttpPort);
const shouldStartHttpServer = Boolean(httpPort && !["stop", "status", "flush"].includes(command));
let httpRequestHandler = null;
let httpServerListening = false;
let httpServer = null;

function setHttpRequestHandler(handler) {
  httpRequestHandler = handler;
}

const httpServerReady = shouldStartHttpServer
  ? startHttpServer()
  : Promise.resolve(false);

async function runCommand(commandName, args = []) {
  return new Promise((resolve) => {
    execFile(commandName, args, (error, stdout = "") => {
      resolve(error ? "" : stdout.trim());
    });
  });
}

async function getListeningPids(port) {
  const lsofOutput = await runCommand("lsof", ["-tiTCP", `-sTCP:LISTEN`, `-iTCP:${port}`]);
  if (lsofOutput) {
    return lsofOutput.split(/\s+/).map(Number).filter(Number.isFinite);
  }

  const fuserOutput = await runCommand("fuser", ["-n", "tcp", String(port)]);
  return fuserOutput.split(/\s+/).map(Number).filter(Number.isFinite);
}

async function getProcessCommand(pid) {
  return runCommand("ps", ["-p", String(pid), "-o", "command="]);
}

function looksLikeArisaProcess(commandText) {
  return /\barisa\b/.test(commandText) || /\/arisa\/src\/index\.js\b/i.test(commandText);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessRunning(pid);
}

async function stopStaleArisaListeners(port) {
  const pids = await getListeningPids(port);
  for (const pid of pids) {
    if (pid === process.pid) continue;
    const commandText = await getProcessCommand(pid);
    if (!looksLikeArisaProcess(commandText)) {
      logger.error("http", `port ${port} is already used by pid ${pid}; not killing non-Arisa process`);
      continue;
    }

    logger.log("http", `stopping stale Arisa listener on port ${port} (pid ${pid})`);
    try {
      process.kill(pid, "SIGTERM");
      if (!await waitForProcessExit(pid)) {
        process.kill(pid, "SIGKILL");
        await waitForProcessExit(pid, 1000);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("http", `failed to stop stale Arisa listener pid ${pid}: ${message}`);
    }
  }
}

async function startHttpServer() {
  await stopStaleArisaListeners(httpPort);
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (httpRequestHandler) return httpRequestHandler(req, res);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return undefined;
    });
    httpServer = server;
    server.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("http", `server failed on port ${httpPort}: ${message}`);
      resolve(false);
    });
    server.listen(httpPort)
      .on("listening", () => {
        httpServerListening = true;
        logger.log("http", `health server on port ${httpPort}`);
        resolve(true);
      });
  });
}

async function getHttpOptions() {
  await httpServerReady;
  return httpServerListening ? { httpPort, setHttpRequestHandler } : {};
}

async function stopHttpServer() {
  if (!httpServerListening || !httpServer) return;
  await new Promise((resolve) => {
    httpServer.close(() => resolve());
  });
  httpServer = null;
  httpServerListening = false;
  httpRequestHandler = null;
}

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

function toBootstrapOverrides(nestedFlags) {
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

function toRuntimeOverrides(nestedFlags) {
  return toBootstrapOverrides(nestedFlags);
}

function toServiceRunnerArgs(nestedFlags) {
  const args = [];
  if (nestedFlags["pi.model"]) {
    args.push("--pi.model", nestedFlags["pi.model"]);
  }
  return args;
}

const webhookUrl = bootstrapOverrides.webhook?.url || "";

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await activeApp?.stop?.();
    await stopHttpServer();
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

async function startRuntimeApp(httpOptions = {}) {
  const app = await createApp({ logger, runtimeOverrides, webhookUrl, ...httpOptions });
  activeApp = app;
  await app.start();
}

async function runForeground() {
  const hasRuntimePiOverrides = Boolean(
    runtimeOverrides?.pi?.model
    || runtimeOverrides?.pi?.provider
    || runtimeOverrides?.pi?.apiKey
  );
  logger.log("app", `starting${verbose ? " in verbose mode" : ""}`);
  const httpOptions = await getHttpOptions();
  await bootstrapIfNeeded({ force: forceBootstrap, cliConfigOverrides: bootstrapOverrides, ...httpOptions });
  try {
    await startRuntimeApp(httpOptions);
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
      await bootstrapIfNeeded({ force: true, cliConfigOverrides: bootstrapOverrides, ...httpOptions });
      await startRuntimeApp(httpOptions);
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
    const httpOptions = await getHttpOptions();
    await bootstrapIfNeeded({ force: forceBootstrap, cliConfigOverrides: bootstrapOverrides, ...httpOptions });
    await stopHttpServer();
    const result = await startService({ verbose, cliArgs: toServiceRunnerArgs(cli.nestedFlags) });
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

try {
  await main();
} catch (error) {
  logger.error("app", error instanceof Error ? error.message : String(error));
  await shutdown(1);
}
