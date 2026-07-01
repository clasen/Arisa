import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import defaults from "./config.js";

const toolName = "turn-server";
const entryPath = fileURLToPath(import.meta.url);
const toolDir = path.dirname(entryPath);
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { getToolStateDir } = await importCore("runtime/paths.js");
const stateRoot = getToolStateDir(toolName);
const paths = {
  root: stateRoot,
  pidFile: path.join(stateRoot, "daemon.pid"),
  statusFile: path.join(stateRoot, "status.json"),
  configFile: path.join(stateRoot, "turnserver.conf"),
  secretFile: path.join(stateRoot, "secret"),
  logFile: path.join(stateRoot, "daemon.log")
};

function printHelp() {
  console.log(`turn-server

Usage:
  node index.js start
  node index.js stop
  node index.js status
  node index.js run --request-file <json>

Runs coturn on UDP/TCP 3478 with REST API time-limited credentials.
The signaling service should expose credentials through /signaling/ice-servers.
`);
}

async function readJson(file, fallback = {}) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function ensureSecret(config) {
  await mkdir(paths.root, { recursive: true });
  if (config.secret) return config.secret;
  try {
    const existing = (await readFile(paths.secretFile, "utf8")).trim();
    if (existing) return existing;
  } catch {}
  const secret = randomBytes(32).toString("base64url");
  await writeFile(paths.secretFile, `${secret}\n`, { mode: 0o600 });
  return secret;
}

function makeCoturnConfig(config, secret) {
  return `listening-port=${config.listeningPort}
listening-ip=0.0.0.0
relay-ip=0.0.0.0
min-port=${config.minPort}
max-port=${config.maxPort}
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=${secret}
realm=${config.realm}
server-name=${config.serverName}
no-cli
no-tls
no-dtls
no-multicast-peers
no-loopback-peers
stale-nonce=600
max-allocate-lifetime=3600
total-quota=1200
user-quota=12
bps-capacity=0
log-file=stdout
simple-log
`;
}

async function start() {
  await mkdir(paths.root, { recursive: true });
  if (!existsSync("/usr/bin/turnserver") && !existsSync("/bin/turnserver")) {
    throw new Error("coturn is not installed. Install package: coturn");
  }
  const current = await readJson(paths.pidFile, {});
  if (isProcessAlive(current.pid)) return { ok: true, action: "start", pid: current.pid, status: await readJson(paths.statusFile, {}), paths };

  const config = await loadToolConfig(toolName, defaults);
  const secret = await ensureSecret(config);
  await writeFile(paths.configFile, makeCoturnConfig(config, secret), { mode: 0o600 });

  const out = openSync(paths.logFile, "a");
  try {
    const child = spawn("turnserver", ["-c", paths.configFile], {
      cwd: toolDir,
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env
    });
    child.unref();
    const startedAt = new Date().toISOString();
    await writeJson(paths.pidFile, { pid: child.pid, startedAt, entryPath });
    await writeJson(path.join(paths.root, "daemon.meta.json"), {
      toolName,
      entryPath,
      autoStart: true,
      command: "node index.js start",
      publicPorts: ["3478/udp", "3478/tcp"],
      turnUrls: [`turn:${config.publicHost}:${config.listeningPort}?transport=udp`, `turn:${config.publicHost}:${config.listeningPort}?transport=tcp`],
      signalingEnv: {
        SIGNALING_TURN_URLS: `turn:${config.publicHost}:${config.listeningPort}?transport=udp,turn:${config.publicHost}:${config.listeningPort}?transport=tcp`,
        SIGNALING_TURN_SECRET: secret
      }
    });
    await writeJson(paths.statusFile, {
      state: "ready",
      message: "coturn is running",
      pid: child.pid,
      realm: config.realm,
      publicHost: config.publicHost,
      port: Number(config.listeningPort),
      relayPorts: [Number(config.minPort), Number(config.maxPort)],
      turnUrls: [`turn:${config.publicHost}:${config.listeningPort}?transport=udp`, `turn:${config.publicHost}:${config.listeningPort}?transport=tcp`],
      updatedAt: startedAt
    });
    return { ok: true, action: "start", pid: child.pid, status: await readJson(paths.statusFile, {}), paths };
  } finally {
    closeSync(out);
  }
}

async function stop() {
  const current = await readJson(paths.pidFile, {});
  if (isProcessAlive(current.pid)) {
    try { process.kill(current.pid, "SIGTERM"); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (isProcessAlive(current.pid)) { try { process.kill(current.pid, "SIGKILL"); } catch {} }
  }
  await rm(paths.pidFile, { force: true });
  await writeJson(paths.statusFile, { state: "stopped", pid: null, updatedAt: new Date().toISOString() });
  return { ok: true, action: "stop", pid: current.pid || null };
}

async function status() {
  const current = await readJson(paths.pidFile, {});
  return { ...(await readJson(paths.statusFile, { state: "unknown" })), pid: current.pid || null, alive: isProcessAlive(current.pid), paths };
}

function resultOk(value) { return { ok: true, output: { text: JSON.stringify(value, null, 2), mimeType: "application/json" } }; }
function resultError(error) { return { ok: false, error: error?.message || String(error) }; }

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const action = request.args?.action || request.args?.mode || "status";
  if (action === "start") return start();
  if (action === "stop") return stop();
  return status();
}

const [command, flag, requestFile] = process.argv.slice(2);
try {
  if (!command || command === "help" || command === "--help") printHelp();
  else if (command === "start") console.log(JSON.stringify(resultOk(await start())));
  else if (command === "stop") console.log(JSON.stringify(resultOk(await stop())));
  else if (command === "status") console.log(JSON.stringify(resultOk(await status())));
  else if (command === "run" && flag === "--request-file") console.log(JSON.stringify(resultOk(await run(requestFile))));
  else printHelp();
} catch (error) {
  console.log(JSON.stringify(resultError(error)));
}
