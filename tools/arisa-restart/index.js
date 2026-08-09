import { open, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import defaults from "./config.js";
import {
  acquireLock,
  assertServiceIdentity,
  clampNumber,
  initializeUtf8Log,
  isProcessAlive,
  isTrue,
  readPidFile,
  readUtf8Json,
  retireLock,
  waitFor,
  writeUtf8Json
} from "./lib.js";
import { queueNotification } from "./worker.js";

const toolName = "arisa-restart";
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const workerFile = path.join(toolDir, "worker.js");
const importCore = (relativePath) => import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, "src", relativePath)).href);
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { arisaIpcSocketFile, arisaPackageDir, getToolStateDir, serviceLogFile, servicePidFile } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`arisa-restart

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions:
  preflight  Verify that the active PID belongs to this Arisa service.
  status     Read the latest restart job, or args.jobId when supplied.
  restart    Hand restart to an independent detached worker. Requires args.confirm=true.

Example request args:
  { "action": "restart", "confirm": true }

Safety:
  - performs no Git fetch, update, checkout, or dependency installation
  - records exact PID command identity and Linux process start time before signalling
  - uses a token-owned lock and worker handshake to prevent concurrent restarts
  - the detached worker survives shutdown of the active Arisa service
  - verifies the replacement repeatedly through PID identity and Arisa IPC
  - safely escalates a hung verified service from SIGTERM to SIGKILL
  - retries a failed start only after proving the old process is gone
`);
}

function statePaths() {
  const stateDir = getToolStateDir(toolName);
  return {
    jobsDir: path.join(stateDir, "jobs"),
    lockFile: path.join(stateDir, "active-job.lock"),
    latestFile: path.join(stateDir, "latest.json")
  };
}

async function readRequest(requestFile) {
  if (!requestFile) throw new Error("--request-file is required");
  return JSON.parse((await readFile(requestFile, "utf8")).replace(/^\uFEFF/, ""));
}

function validJobId(jobId) {
  return /^\d{13}-[0-9a-f]{8}$/.test(jobId);
}

async function currentJob(paths, jobId = "") {
  if (jobId && !validJobId(jobId)) throw new Error("Invalid restart jobId");
  return readUtf8Json(jobId ? path.join(paths.jobsDir, `${jobId}.json`) : paths.latestFile);
}

function publicStatus(status) {
  const fields = [
    "id", "createdAt", "updatedAt", "completedAt", "state", "phase", "failurePhase",
    "workerPid", "oldPid", "newPid", "recoveryPid", "recovered", "stopEscalated", "error", "recoveryError",
    "notificationQueued", "notificationPending", "notificationError"
  ];
  return Object.fromEntries(fields.filter((field) => status[field] !== undefined).map((field) => [field, status[field]]));
}

async function clearStaleLock(paths) {
  const lock = await readUtf8Json(paths.lockFile);
  if (!lock) return;
  const ageMs = Date.now() - Date.parse(lock.createdAt || 0);
  const status = validJobId(String(lock.jobId || "")) ? await currentJob(paths, lock.jobId) : null;
  const activeState = status && ["launching", "queued", "running", "stopping", "starting", "verifying", "recovering"].includes(status.state);
  if (status?.workerPid && isProcessAlive(status.workerPid)) throw new Error(`Restart job ${lock.jobId} still owns the supervisor lock`);
  if ((!status || activeState) && !status?.workerPid && Number.isFinite(ageMs) && ageMs < 15000) {
    throw new Error(`Restart job ${lock.jobId || "unknown"} is still launching`);
  }
  await retireLock(paths.lockFile);
}

function normalizedConfig(config) {
  return {
    handoffDelayMs: clampNumber(config.handoffDelayMs, defaults.handoffDelayMs, 1000, 30000),
    stopTimeoutMs: clampNumber(config.stopTimeoutMs, defaults.stopTimeoutMs, 5000, 180000),
    killTimeoutMs: clampNumber(config.killTimeoutMs, defaults.killTimeoutMs, 1000, 60000),
    startTimeoutMs: clampNumber(config.startTimeoutMs, defaults.startTimeoutMs, 10000, 300000),
    verifyTimeoutMs: clampNumber(config.verifyTimeoutMs, defaults.verifyTimeoutMs, 10000, 180000),
    stabilityWindowMs: clampNumber(config.stabilityWindowMs, defaults.stabilityWindowMs, 2000, 30000),
    notifyOnCompletion: config.notifyOnCompletion !== false && String(config.notifyOnCompletion).toLowerCase() !== "false"
  };
}

async function preflight() {
  const pid = await readPidFile(servicePidFile);
  if (!isProcessAlive(pid)) throw new Error("The Arisa background service is not running");
  const entryFile = path.join(arisaPackageDir, "src", "index.js");
  const identity = await assertServiceIdentity(pid, entryFile);
  const restartArgs = identity.argv.slice(2).filter((arg) => arg !== "--service-runner");
  return { pid, startTime: identity.startTime, entryFile, restartArgs };
}

async function launchJob(request, config, service) {
  const paths = statePaths();
  await clearStaleLock(paths);
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const lockToken = crypto.randomUUID();
  await acquireLock(paths.lockFile, { jobId: id, token: lockToken, createdAt: new Date().toISOString() });
  const statusFile = path.join(paths.jobsDir, `${id}.json`);
  const logFile = path.join(paths.jobsDir, `${id}.log`);
  const job = {
    id,
    chatId: request.chatId == null ? null : String(request.chatId),
    createdAt: new Date().toISOString(),
    packageDir: arisaPackageDir,
    entryFile: service.entryFile,
    workerFile,
    pidFile: servicePidFile,
    serviceLogFile,
    ipcSocketFile: arisaIpcSocketFile,
    oldPid: service.pid,
    oldStartTime: service.startTime,
    restartArgs: service.restartArgs,
    statusFile,
    latestFile: paths.latestFile,
    lockFile: paths.lockFile,
    lockToken,
    logFile,
    config: normalizedConfig(config)
  };
  const initial = { ...job, state: "launching", phase: "handoff", workerPid: null, updatedAt: new Date().toISOString() };
  await writeUtf8Json(statusFile, initial);
  await writeUtf8Json(paths.latestFile, initial);
  await initializeUtf8Log(logFile);

  const logHandle = await open(logFile, "a");
  let child;
  let spawnError = null;
  let earlyExit = null;
  try {
    child = spawn(process.execPath, [workerFile, statusFile], {
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: { ...process.env, ARISA_IPC_TOKEN: "" }
    });
    child.once("error", (error) => { spawnError = error; });
    child.once("exit", (code, signal) => { earlyExit = { code, signal }; });
    child.unref();
  } finally {
    await logHandle.close();
  }

  const handshaken = await waitFor(async () => {
    if (spawnError || earlyExit) return true;
    const status = await readUtf8Json(statusFile);
    return status?.state === "queued" && status.workerPid === child.pid && isProcessAlive(child.pid);
  }, { timeoutMs: 5000, intervalMs: 100 });
  const status = await readUtf8Json(statusFile);
  if (!handshaken || spawnError || earlyExit || status?.state !== "queued" || status.workerPid !== child.pid || !isProcessAlive(child.pid)) {
    await retireLock(paths.lockFile);
    const detail = spawnError?.message || (earlyExit ? `worker exited (${earlyExit.code ?? earlyExit.signal})` : "worker handshake timed out");
    throw new Error(`Could not hand restart to the detached worker: ${detail}`);
  }
  return status;
}

async function run(requestFile) {
  try {
    const request = await readRequest(requestFile);
    const action = String(request.args?.action || "preflight").trim().toLowerCase();
    const paths = statePaths();
    if (action === "status") {
      let status = await currentJob(paths, String(request.args?.jobId || ""));
      if (!status) throw new Error("No Arisa restart job was found");
      if (status.notificationPending && isProcessAlive(await readPidFile(servicePidFile))) {
        status = await queueNotification(status, status);
      }
      console.log(JSON.stringify(toolOk({ text: `Arisa restart job ${status.id}: ${status.state} (${status.phase})`, ...publicStatus(status) })));
      return;
    }
    if (action === "preflight") {
      const service = await preflight();
      console.log(JSON.stringify(toolOk({
        text: `Arisa restart preflight passed for service PID ${service.pid}.`,
        servicePid: service.pid,
        serviceRunning: true
      })));
      return;
    }
    if (action !== "restart") throw new Error(`Unsupported action: ${action}`);
    if (!isTrue(request.args?.confirm)) throw new Error("args.confirm=true is required to restart Arisa");
    const service = await preflight();
    const loadedConfig = await loadToolConfig(toolName, defaults, request.chatId);
    const config = { ...loadedConfig, ...request.args };
    const job = await launchJob(request, config, service);
    console.log(JSON.stringify(toolOk({
      text: `Safe Arisa restart job ${job.id} was handed to detached worker PID ${job.workerPid}. It will verify stable service health and report the result asynchronously.`,
      jobId: job.id,
      workerPid: job.workerPid,
      oldPid: job.oldPid,
      state: job.state
    }, { status: "accepted" })));
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
  }
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args[0] === "help") {
  printHelp();
} else if (args[0] === "run") {
  const fileIndex = args.indexOf("--request-file");
  await run(fileIndex >= 0 ? args[fileIndex + 1] : "");
} else {
  printHelp();
}
