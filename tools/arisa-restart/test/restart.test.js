import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireLock,
  assertServiceIdentity,
  clampNumber,
  isProcessAlive,
  isTrue,
  readUtf8Json,
  retireLock,
  terminalPrompt,
  waitFor,
  writeUtf8Json
} from "../lib.js";
import { queueNotification, requestIpc, terminateVerifiedService } from "../worker.js";
import { retryPendingNotification } from "../notifier.js";

test("normalizes booleans and bounded restart timeouts", () => {
  assert.equal(isTrue(true), true);
  assert.equal(isTrue("TRUE"), true);
  assert.equal(isTrue("false"), false);
  assert.equal(clampNumber("15", 5, 10, 20), 15);
  assert.equal(clampNumber("500", 5, 10, 20), 20);
  assert.equal(clampNumber("invalid", 5, 10, 20), 5);
});

test("writes BOM JSON and atomically retires completed lock files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-restart-lock-"));
  try {
    const statusFile = path.join(root, "status.json");
    await writeUtf8Json(statusFile, { state: "queued" });
    const bytes = await readFile(statusFile);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.deepEqual(await readUtf8Json(statusFile), { state: "queued" });

    const lockFile = path.join(root, "active.lock");
    await acquireLock(lockFile, { jobId: "one", token: "owner" });
    await assert.rejects(acquireLock(lockFile, { jobId: "two", token: "other" }), /EEXIST/);
    assert.equal((await readUtf8Json(lockFile)).token, "owner");
    assert.equal(await retireLock(lockFile), true);
    assert.equal(await retireLock(lockFile), false);
    await acquireLock(lockFile, { jobId: "two", token: "other" });
    assert.equal((await readUtf8Json(lockFile)).token, "other");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires exact Arisa argv and process start time before signalling", async () => {
  if (process.platform !== "linux") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-restart-pid-"));
  const entryFile = path.join(root, "service.js");
  await writeFile(entryFile, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [entryFile, "--service-runner"], { stdio: "ignore" });
  try {
    assert.equal(await waitFor(() => isProcessAlive(child.pid), { timeoutMs: 2000 }), true);
    const identity = await assertServiceIdentity(child.pid, entryFile);
    assert.equal(identity.pid, child.pid);
    assert.ok(identity.startTime);
    await assert.rejects(assertServiceIdentity(child.pid, `${entryFile}.wrong`), /not the expected/);
    await assert.rejects(assertServiceIdentity(child.pid, entryFile, `${identity.startTime}9`), /reused/);
  } finally {
    child.kill("SIGTERM");
    await waitFor(() => !isProcessAlive(child.pid), { timeoutMs: 2000 });
    await rm(root, { recursive: true, force: true });
  }
});

test("escalates a verified service that ignores SIGTERM", { timeout: 5000 }, async () => {
  if (process.platform !== "linux") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-restart-kill-"));
  const entryFile = path.join(root, "hung-service.js");
  const readyFile = path.join(root, "ready");
  await writeFile(entryFile, "import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); writeFileSync(process.argv[3], 'ready'); setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [entryFile, "--service-runner", readyFile], { stdio: "ignore" });
  try {
    assert.equal(await waitFor(async () => {
      try { return (await readFile(readyFile, "utf8")) === "ready"; } catch { return false; }
    }, { timeoutMs: 2000 }), true);
    const identity = await assertServiceIdentity(child.pid, entryFile);
    const result = await terminateVerifiedService({
      entryFile,
      config: { stopTimeoutMs: 300, killTimeoutMs: 2000 }
    }, identity);
    assert.equal(result.forced, true);
    assert.equal(isProcessAlive(child.pid), false);
  } finally {
    if (isProcessAlive(child.pid)) process.kill(child.pid, "SIGKILL");
    await waitFor(() => !isProcessAlive(child.pid), { timeoutMs: 2000 });
    await rm(root, { recursive: true, force: true });
  }
});

test("uses the explicit Arisa IPC capability envelope", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-restart-ipc-"));
  const socketPath = path.join(root, "arisa.sock");
  let observed;
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      observed = JSON.parse(buffer.slice(0, newline));
      socket.end(`${JSON.stringify({ id: observed.id, ok: true, result: [] })}\n`);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    assert.deepEqual(await requestIpc({ socketPath, chatId: "123" }), []);
    assert.equal(observed.method, "tools.list");
    assert.equal(observed.toolName, "arisa-restart");
    assert.equal(observed.chatId, "123");
    assert.equal(observed.capabilityToken, "");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("builds bounded terminal prompts for success and failure", () => {
  const job = { id: "job-1" };
  assert.match(terminalPrompt(job, { state: "succeeded", newPid: 20 }), /completed/);
  assert.match(terminalPrompt(job, { state: "succeeded", recovered: true, newPid: 30 }), /recovery attempt/);
  const prompt = terminalPrompt(job, { state: "failed", phase: "verify", error: "x".repeat(5000) });
  assert.match(prompt, /failed during verify/);
  assert.ok(prompt.length < 1200);
});


test("detached worker stops, starts, and stably verifies a fake Arisa service", { timeout: 15000 }, async () => {
  if (process.platform !== "linux") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-restart-e2e-"));
  const entryFile = path.join(root, "fake-arisa.js");
  const pidFile = path.join(root, "arisa.pid");
  const socketPath = path.join(root, "arisa.sock");
  const serviceLogFile = path.join(root, "arisa.log");
  const runnerArgsFile = path.join(root, "runner-args.json");
  const statusFile = path.join(root, "job.json");
  const latestFile = path.join(root, "latest.json");
  const lockFile = path.join(root, "active.lock");
  const previousStateDir = process.env.ARISA_RESTART_TEST_STATE_DIR;
  process.env.ARISA_RESTART_TEST_STATE_DIR = root;
  const fakeSource = `
import { appendFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
const root = process.env.ARISA_RESTART_TEST_STATE_DIR;
const pidFile = path.join(root, "arisa.pid");
const socketPath = path.join(root, "arisa.sock");
const logFile = path.join(root, "arisa.log");
const runnerArgsFile = path.join(root, "runner-args.json");
if (process.argv.includes("--service-runner")) {
  await writeFile(pidFile, String(process.pid) + "\\n");
  await writeFile(runnerArgsFile, JSON.stringify(process.argv.slice(2)));
  await appendFile(logFile, "[telegram] bot polling started\\n");
  await rm(socketPath, { force: true });
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      const newline = data.indexOf("\\n");
      if (newline < 0) return;
      const request = JSON.parse(data.slice(0, newline));
      socket.end(JSON.stringify({ id: request.id, ok: true, result: [] }) + "\\n");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(pidFile, { force: true });
    await rm(socketPath, { force: true });
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  setInterval(() => {}, 1000);
} else if (process.argv[2] === "start") {
  const child = spawn(process.execPath, [process.argv[1], "--service-runner", ...process.argv.slice(3)], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
}
`;
  let latestPid = null;
  try {
    await writeFile(entryFile, fakeSource);
    await writeFile(serviceLogFile, "");
    const old = spawn(process.execPath, [entryFile, "--service-runner", "--prime.model", "fake-model", "--silent"], { detached: true, stdio: "ignore", env: process.env });
    old.unref();
    assert.equal(await waitFor(async () => {
      try { return Number((await readFile(pidFile, "utf8")).trim()) === old.pid; } catch { return false; }
    }, { timeoutMs: 3000 }), true);
    const oldIdentity = await assertServiceIdentity(old.pid, entryFile);
    const job = {
      id: "test-job",
      chatId: null,
      createdAt: new Date().toISOString(),
      packageDir: root,
      entryFile,
      workerFile: path.resolve(new URL("../worker.js", import.meta.url).pathname),
      pidFile,
      serviceLogFile,
      ipcSocketFile: socketPath,
      oldPid: old.pid,
      oldStartTime: oldIdentity.startTime,
      restartArgs: oldIdentity.argv.slice(2).filter((arg) => arg !== "--service-runner"),
      statusFile,
      latestFile,
      lockFile,
      lockToken: "test-token",
      config: {
        handoffDelayMs: 500,
        stopTimeoutMs: 3000,
        killTimeoutMs: 2000,
        startTimeoutMs: 3000,
        verifyTimeoutMs: 5000,
        stabilityWindowMs: 500,
        notifyOnCompletion: false
      },
      state: "launching",
      phase: "handoff"
    };
    await acquireLock(lockFile, { jobId: job.id, token: job.lockToken, createdAt: new Date().toISOString() });
    await writeUtf8Json(statusFile, job);
    const workerFile = path.resolve(new URL("../worker.js", import.meta.url).pathname);
    const supervisor = spawn(process.execPath, [workerFile, statusFile], {
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    supervisor.unref();
    assert.equal(await waitFor(async () => {
      const current = await readUtf8Json(statusFile);
      return current?.state === "queued" && current.workerPid === supervisor.pid;
    }, { timeoutMs: 3000 }), true);
    assert.equal(await waitFor(async () => {
      const current = await readUtf8Json(statusFile);
      return ["succeeded", "failed"].includes(current?.state);
    }, { timeoutMs: 10000 }), true);
    const status = await readUtf8Json(statusFile);
    assert.equal(status.state, "succeeded");
    assert.equal(status.recovered, false);
    assert.notEqual(status.newPid, old.pid);
    latestPid = status.newPid;
    assert.equal(isProcessAlive(old.pid), false);
    assert.equal(isProcessAlive(latestPid), true);
    assert.equal((await readUtf8Json(lockFile)).token, "test-token");
    assert.deepEqual(JSON.parse(await readFile(runnerArgsFile, "utf8")), [
      "--service-runner", "--prime.model", "fake-model", "--silent"
    ]);
  } finally {
    try {
      const raw = await readFile(pidFile, "utf8");
      const pid = Number(raw.trim());
      if (isProcessAlive(pid)) process.kill(pid, "SIGTERM");
      await waitFor(() => !isProcessAlive(pid), { timeoutMs: 3000 });
    } catch {}
    if (previousStateDir === undefined) delete process.env.ARISA_RESTART_TEST_STATE_DIR;
    else process.env.ARISA_RESTART_TEST_STATE_DIR = previousStateDir;
    await rm(root, { recursive: true, force: true });
  }
});


test("notification claims prevent concurrent duplicate agent events", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-restart-notify-"));
  const socketPath = path.join(root, "arisa.sock");
  const statusFile = path.join(root, "job.json");
  const latestFile = path.join(root, "latest.json");
  let requests = 0;
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let data = "";
    socket.on("data", async (chunk) => {
      data += chunk;
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(data.slice(0, newline));
      requests += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { id: "task" } })}\n`);
    });
  });
  const job = {
    id: "notify-job",
    chatId: "123",
    statusFile,
    latestFile,
    ipcSocketFile: socketPath,
    config: { notifyOnCompletion: true },
    state: "succeeded",
    phase: "complete",
    newPid: 42,
    notificationPending: true
  };
  try {
    await writeUtf8Json(statusFile, job);
    await writeUtf8Json(latestFile, { id: "newer-job", state: "running" });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await Promise.all([queueNotification(job, job), queueNotification(job, job)]);
    assert.equal(requests, 1);
    assert.equal((await readUtf8Json(statusFile)).notificationQueued, true);
    assert.equal((await readUtf8Json(latestFile)).id, "newer-job");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("pending notification retry waits for IPC recovery", { timeout: 5000 }, async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-restart-notifier-"));
  const socketPath = path.join(root, "arisa.sock");
  const statusFile = path.join(root, "job.json");
  const latestFile = path.join(root, "latest.json");
  const job = {
    id: "retry-job",
    chatId: "123",
    statusFile,
    latestFile,
    ipcSocketFile: socketPath,
    config: { notifyOnCompletion: true },
    state: "failed",
    phase: "verify",
    error: "service down",
    notificationPending: true
  };
  let requests = 0;
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(data.slice(0, newline));
      requests += 1;
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { id: "task" } })}\n`);
    });
  });
  try {
    await writeUtf8Json(statusFile, job);
    await writeUtf8Json(latestFile, job);
    const retry = retryPendingNotification(statusFile, { retryIntervalMs: 50, retryTimeoutMs: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    const result = await retry;
    assert.equal(result.notificationQueued, true);
    assert.equal(requests, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
