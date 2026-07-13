import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
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
const { createDaemonRuntime } = await importCore("core/tools/daemon-runtime.js");
const { isProcessAlive, readJson, writeJson } = await importCore("core/tools/daemon-processes.js");
const { loadDaemonPolicy } = await importCore("core/tools/daemon-policy.js");
const daemon = createDaemonRuntime({ toolName, entryPath, autoStart: true });
const stateRoot = daemon.paths.root;
const paths = {
  ...daemon.paths,
  configFile: path.join(stateRoot, "turnserver.conf"),
  secretFile: path.join(stateRoot, "secret"),
  coturnPidFile: path.join(stateRoot, "coturn.pid"),
  coturnLogFile: path.join(stateRoot, "coturn.log")
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

async function prepareCoturn() {
  const config = await loadToolConfig(toolName, defaults);
  const secret = await ensureSecret(config);
  await writeFile(paths.configFile, makeCoturnConfig(config, secret), { mode: 0o600 });
  return config;
}

function assertCoturnInstalled() {
  if (!existsSync("/usr/bin/turnserver") && !existsSync("/bin/turnserver")) {
    throw new Error("coturn is not installed. Install package: coturn");
  }
}

async function spawnCoturn() {
  const out = openSync(paths.coturnLogFile, "a");
  try {
    const child = spawn("turnserver", ["-c", paths.configFile], {
      cwd: toolDir,
      detached: false,
      stdio: ["ignore", out, out],
      env: process.env
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await writeJson(paths.coturnPidFile, { pid: child.pid, startedAt: new Date().toISOString() });
    return child;
  } finally {
    closeSync(out);
  }
}

async function stopCoturn(policy) {
  const current = await readJson(paths.coturnPidFile, {});
  if (isProcessAlive(current.pid)) {
    try { process.kill(current.pid, "SIGTERM"); } catch {}
    const startedAt = Date.now();
    while (isProcessAlive(current.pid) && Date.now() - startedAt < policy.stopTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, policy.queuePollIntervalMs));
    }
    if (isProcessAlive(current.pid)) {
      try { process.kill(current.pid, "SIGKILL"); } catch {}
    }
  }
  await rm(paths.coturnPidFile, { force: true });
}

async function probeTcp(port, timeoutMs) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`coturn TCP probe timed out on port ${port}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function probeStun(port, timeoutMs) {
  const request = Buffer.alloc(20);
  request.writeUInt16BE(0x0001, 0);
  request.writeUInt16BE(0, 2);
  request.writeUInt32BE(0x2112a442, 4);
  randomBytes(12).copy(request, 8);

  await new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`coturn STUN probe timed out on port ${port}`));
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
    socket.once("message", (response) => {
      clearTimeout(timer);
      socket.close();
      if (response.length < 20 || response.readUInt16BE(0) !== 0x0101 || !response.subarray(8, 20).equals(request.subarray(8, 20))) {
        reject(new Error("coturn returned an invalid STUN binding response"));
        return;
      }
      resolve();
    });
    socket.send(request, port, "127.0.0.1");
  });
}

async function turnHealth(config, policy) {
  const port = Number(config.listeningPort);
  const timeoutMs = Math.max(1, Math.floor(policy.healthTimeoutMs / 2));
  await Promise.all([probeTcp(port, timeoutMs), probeStun(port, timeoutMs)]);
  return { message: `coturn answered TCP and STUN probes on port ${port}` };
}

function turnDetails(config) {
  const turnUrls = [
    `turn:${config.publicHost}:${config.listeningPort}?transport=udp`,
    `turn:${config.publicHost}:${config.listeningPort}?transport=tcp`
  ];
  return {
    realm: config.realm,
    publicHost: config.publicHost,
    port: Number(config.listeningPort),
    relayPorts: [Number(config.minPort), Number(config.maxPort)],
    turnUrls
  };
}

async function runDaemon() {
  assertCoturnInstalled();
  const policy = await loadDaemonPolicy();
  let config = await prepareCoturn();
  await stopCoturn(policy);
  await spawnCoturn();
  let details = turnDetails(config);
  await daemon.writeStatus(details);

  const shutdown = async () => {
    await stopCoturn(policy);
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await daemon.workLoop({
    processJob: async () => ({ turnUrls: details.turnUrls }),
    healthCheck: () => turnHealth(config, policy),
    recover: async () => {
      await stopCoturn(policy);
      config = await prepareCoturn();
      await spawnCoturn();
      details = turnDetails(config);
      await daemon.writeStatus(details);
      return true;
    }
  });
}

async function start() {
  const pid = await daemon.start();
  const status = await daemon.ensureReady();
  return { ok: true, action: "start", pid, status, paths };
}

async function stop() {
  const pid = await daemon.getPid();
  await daemon.stop();
  return { ok: true, action: "stop", pid: pid || null };
}

async function status() {
  const pid = await daemon.getPid();
  const coturn = await readJson(paths.coturnPidFile, {});
  return {
    ...(await readJson(paths.statusFile, { state: "stopped" })),
    pid: pid || null,
    alive: isProcessAlive(pid),
    coturnPid: coturn.pid || null,
    coturnAlive: isProcessAlive(coturn.pid),
    paths
  };
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
  else if (command === "daemon") await runDaemon();
  else if (command === "start") console.log(JSON.stringify(resultOk(await start())));
  else if (command === "stop") console.log(JSON.stringify(resultOk(await stop())));
  else if (command === "status") console.log(JSON.stringify(resultOk(await status())));
  else if (command === "run" && flag === "--request-file") console.log(JSON.stringify(resultOk(await run(requestFile))));
  else printHelp();
} catch (error) {
  console.log(JSON.stringify(resultError(error)));
}
