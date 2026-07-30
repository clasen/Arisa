import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const homeDir = await mkdtemp(path.join(os.tmpdir(), "arisa-daemon-test-"));
process.env.ARISA_HOME = homeDir;

const policy = {
  supervisorIntervalMs: 20,
  heartbeatIntervalMs: 20,
  heartbeatStaleMs: 150,
  healthIntervalMs: 100,
  healthTimeoutMs: 1_000,
  healthRetryLimit: 1,
  healthRetryBackoffMs: 10,
  restartLimit: 2,
  restartBackoffMs: 20,
  restartBackoffMaxMs: 40,
  startupTimeoutMs: 2_000,
  stopTimeoutMs: 300,
  queuePollIntervalMs: 10
};

await mkdir(path.join(homeDir, "state"), { recursive: true });
await writeFile(
  path.join(homeDir, "state", "config.json"),
  `${JSON.stringify({ daemons: policy }, null, 2)}\n`,
  "utf8"
);

const {
  daemonPaths,
  isProcessAlive,
  readJson,
  stopManagedDaemon
} = await import("../src/core/tools/daemon-processes.js");
const {
  createDaemonRuntime,
  isDaemonReady
} = await import("../src/core/tools/daemon-runtime.js");
const { createToolProcessSupervisor } = await import("../src/runtime/tool-process-supervisor.js");

const fixtureEntry = fileURLToPath(new URL("../test-fixtures/fake-daemon.js", import.meta.url));

function runtimeFor(scope, options = {}) {
  return createDaemonRuntime({
    toolName: "fake-daemon",
    entryPath: fixtureEntry,
    scope,
    startupContext: options.startupContext || { health: "ok" },
    autoStart: options.autoStart ?? false
  });
}

async function waitFor(check, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Condition was not met after ${timeoutMs}ms`);
}

test.after(async () => {
  for (const scope of [{ type: "global" }, { type: "chat", chatId: "101" }, { type: "chat", chatId: "202" }]) {
    await stopManagedDaemon({ toolName: "fake-daemon", scope }).catch(() => {});
  }
  await rm(homeDir, { recursive: true, force: true });
});

test("runs health through the queue before accepting jobs", async () => {
  const runtime = runtimeFor({ type: "global" });
  const output = await runtime.submit({ value: "hello" }, { timeoutMs: 1_000 });
  assert.deepEqual(output, { echo: "hello" });

  const status = await readJson(runtime.paths.statusFile, {});
  const pid = await runtime.getPid();
  assert.equal(status.state, "ready");
  assert.ok(status.heartbeatAt);
  assert.ok(status.lastHealthSuccessAt);
  assert.ok(status.lastSuccessfulJobAt);
  assert.equal(isDaemonReady(status, pid, policy), true);

  await assert.rejects(
    () => runtime.submit({ action: "fail" }, { timeoutMs: 1_000 }),
    /synthetic job failure/
  );
  const failedStatus = await readJson(runtime.paths.statusFile, {});
  assert.equal(failedStatus.lastSuccessfulJobAt, status.lastSuccessfulJobAt);
  assert.equal(failedStatus.lastError.phase, "job");

  await runtime.stop();
});

test("isolates daemon process files and context by chat scope", async () => {
  const first = runtimeFor({ type: "chat", chatId: "101" });
  const second = runtimeFor({ type: "chat", chatId: "202" });
  await first.submit({ value: "first" }, { timeoutMs: 2_000 });
  await second.submit({ value: "second" }, { timeoutMs: 2_000 });

  const firstPid = await first.getPid();
  const secondPid = await second.getPid();
  assert.notEqual(firstPid, secondPid);
  assert.notEqual(first.paths.root, second.paths.root);

  const firstMeta = JSON.parse(await readFile(first.paths.metaFile, "utf8"));
  const secondMeta = JSON.parse(await readFile(second.paths.metaFile, "utf8"));
  assert.deepEqual(firstMeta.scope, { type: "chat", chatId: "101" });
  assert.deepEqual(secondMeta.scope, { type: "chat", chatId: "202" });
  assert.deepEqual(firstMeta.startupContext, { health: "ok" });

  await Promise.all([first.stop(), second.stop()]);
});

test("supervisor ignores invalid chat directories and recovers valid daemons", async () => {
  const invalidChatDir = path.join(homeDir, "chats", "24137857-c513-4f53-b39d-1b28f51ebbb6");
  await mkdir(path.join(invalidChatDir, "state", "tools", "orphaned-tool"), { recursive: true });

  const runtime = runtimeFor({ type: "chat", chatId: "202" }, {
    autoStart: true,
    startupContext: { health: "ok" }
  });
  let supervisor;

  try {
    await runtime.submit({ value: "before" }, { timeoutMs: 1_000 });
    const oldPid = await runtime.getPid();
    process.kill(oldPid, "SIGKILL");
    await waitFor(() => !isProcessAlive(oldPid));

    supervisor = createToolProcessSupervisor({ policy });
    await supervisor.start();

    const newPid = await waitFor(async () => {
      const pid = await runtime.getPid();
      const status = await readJson(runtime.paths.statusFile, {});
      return pid && pid !== oldPid && status.state === "ready" ? pid : null;
    });
    assert.notEqual(newPid, oldPid);
  } finally {
    await supervisor?.stop();
    await runtime.stop().catch(() => {});
    await rm(invalidChatDir, { recursive: true, force: true });
  }
});

test("rejects stale readiness even when the pid is alive", async () => {
  const status = {
    state: "ready",
    heartbeatAt: new Date(Date.now() - policy.heartbeatStaleMs - 1).toISOString(),
    lastHealthSuccessAt: new Date().toISOString()
  };
  assert.equal(isDaemonReady(status, process.pid, policy), false);
});

test("does not auto-start an intentionally stopped on-demand daemon", async () => {
  const runtime = runtimeFor({ type: "global" }, { autoStart: false });
  await runtime.submit({ value: "once" }, { timeoutMs: 2_000 });
  await runtime.stop();

  const supervisor = createToolProcessSupervisor({ policy });
  await supervisor.start();
  await new Promise((resolve) => setTimeout(resolve, policy.supervisorIntervalMs * 3));
  assert.equal(isProcessAlive(await runtime.getPid()), false);
  assert.equal((await readJson(runtime.paths.statusFile, {})).state, "stopped");
  await supervisor.stop();
});

test("external supervisor recovers internally before restarting", async () => {
  const runtime = runtimeFor({ type: "global" }, {
    autoStart: true,
    startupContext: { health: "fail", recover: true }
  });
  await runtime.start();
  const supervisor = createToolProcessSupervisor({ policy });
  await supervisor.start();

  const status = await waitFor(async () => {
    const current = await readJson(runtime.paths.statusFile, {});
    return current.state === "ready" ? current : null;
  });
  assert.equal(status.state, "ready");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(runtime.paths.root, "recovered.json"), "utf8")),
    { recovered: true }
  );

  await supervisor.stop();
  await runtime.stop();
});

test("external supervisor recreates a dead process with the same context", async () => {
  const scope = { type: "chat", chatId: "101" };
  const runtime = runtimeFor(scope, {
    autoStart: true,
    startupContext: { health: "ok", marker: "preserved" }
  });
  await runtime.submit({ value: "before" }, { timeoutMs: 1_000 });
  const oldPid = await runtime.getPid();
  process.kill(oldPid, "SIGKILL");
  await waitFor(() => !isProcessAlive(oldPid));

  const supervisor = createToolProcessSupervisor({ policy });
  await supervisor.start();
  const newPid = await waitFor(async () => {
    const pid = (await readJson(daemonPaths({ toolName: "fake-daemon", scope }).pidFile, {})).pid;
    const status = await readJson(runtime.paths.statusFile, {});
    return pid && pid !== oldPid && status.state === "ready" ? pid : null;
  });
  assert.notEqual(newPid, oldPid);
  const meta = await readJson(runtime.paths.metaFile, {});
  assert.deepEqual(meta.startupContext, { health: "ok", marker: "preserved" });

  await supervisor.stop();
  await runtime.stop();
});
