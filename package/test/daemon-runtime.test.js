import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  readDaemonDiagnostic,
  readJson,
  stopManagedDaemon,
  unregisterManagedDaemon,
  writeDaemonStatus,
  writeJson
} = await import("../src/core/tools/daemon-processes.js");
const {
  createDaemonRuntime,
  isDaemonReady,
  submitDaemonControl,
  DAEMON_EVENT_TYPES,
  DAEMON_PROTOCOL_VERSION
} = await import("../src/core/tools/daemon-runtime.js");
const { submitDaemonControl: directSubmitDaemonControl } = await import("../src/core/tools/daemon-client.js");
const {
  DAEMON_EVENT_TYPES: directDaemonEventTypes,
  DAEMON_PROTOCOL_VERSION: directDaemonProtocolVersion
} = await import("../src/core/tools/daemon-protocol.js");
const { createToolProcessSupervisor, formatDaemonOutcome } = await import("../src/runtime/tool-process-supervisor.js");
const { superviseDaemon } = await import("../src/core/tools/daemon-health.js");
const { ToolRegistry } = await import("../src/core/tools/tool-registry.js");

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

test("preserves daemon client and protocol exports through the runtime facade", () => {
  assert.equal(submitDaemonControl, directSubmitDaemonControl);
  assert.equal(DAEMON_EVENT_TYPES, directDaemonEventTypes);
  assert.equal(DAEMON_PROTOCOL_VERSION, directDaemonProtocolVersion);
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

test("streams ordered daemon events and persists the terminal result", async () => {
  const runtime = runtimeFor({ type: "global" });
  const events = [];
  const output = await runtime.submit({ action: "stream", value: "done" }, {
    timeoutMs: 1_000,
    onEvent: (event) => events.push(event)
  });

  assert.deepEqual(output, { echo: "done" });
  assert.deepEqual(events.map((event) => event.type), ["accepted", "progress", "chunk", "completed"]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.ok((await readdir(runtime.paths.commandsDir)).some((file) => file.endsWith(".result.json")));
  await runtime.stop();
});

test("cancels a timed-out job without restarting the shared daemon", async () => {
  const runtime = runtimeFor({ type: "global" });
  const jobId = "job-cancelled-on-timeout";
  await assert.rejects(
    () => runtime.submit({ action: "hang-until-cancelled" }, { timeoutMs: 80, jobId }),
    (error) => error.code === "DAEMON_JOB_TIMEOUT"
  );

  const terminal = await waitFor(async () => {
    const result = await readJson(path.join(runtime.paths.commandsDir, `${jobId}.result.json`), null);
    return result?.terminal || null;
  });
  assert.equal(terminal.type, "failed");
  assert.equal(terminal.payload.code, "DAEMON_JOB_CANCELLED");
  const pid = await runtime.getPid();
  assert.equal(isProcessAlive(pid), true);
  assert.deepEqual(await runtime.submit({ value: "after-timeout" }, { timeoutMs: 1_000 }), { echo: "after-timeout" });
  assert.equal(await runtime.getPid(), pid);
  await runtime.stop();
});

test("deduplicates repeated notifications for one durable job id", async () => {
  const runtime = runtimeFor({ type: "global" });
  const jobId = "job-deduplicated";
  const [first, second] = await Promise.all([
    runtime.submit({ action: "count" }, { timeoutMs: 1_000, jobId }),
    runtime.submit({ action: "count" }, { timeoutMs: 1_000, jobId })
  ]);

  assert.deepEqual(first, { count: 1 });
  assert.deepEqual(second, { count: 1 });
  assert.deepEqual(await readJson(path.join(runtime.paths.root, "effects.json"), {}), { count: 1 });
  await runtime.stop();
});

test("recovers queued and accepted journal records after daemon start", async () => {
  const runtime = runtimeFor({ type: "global" });
  await runtime.ensure();
  await writeJson(path.join(runtime.paths.commandsDir, "job-recovered.request.json"), {
    id: "job-recovered",
    status: "queued",
    queuedAt: new Date().toISOString(),
    payload: { value: "queued" }
  });
  await writeJson(path.join(runtime.paths.commandsDir, "job-accepted.processing.json"), {
    id: "job-accepted",
    status: "accepted",
    queuedAt: new Date().toISOString(),
    acceptedAt: new Date().toISOString(),
    payload: { value: "accepted" }
  });

  const [queued, accepted] = await Promise.all([
    runtime.submit({ value: "ignored" }, { timeoutMs: 1_000, jobId: "job-recovered" }),
    runtime.submit({ value: "ignored" }, { timeoutMs: 1_000, jobId: "job-accepted" })
  ]);
  assert.deepEqual(queued, { echo: "queued" });
  assert.deepEqual(accepted, { echo: "accepted" });
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

test("does not restart registrations whose scope no longer matches the tool manifest", async () => {
  const runtime = runtimeFor({ type: "global" }, { autoStart: true });
  const registry = new ToolRegistry();
  registry.tools.set("fake-daemon", {
    name: "fake-daemon",
    entry: fixtureEntry,
    daemon: { scope: "chat", autoStart: false, health: "internal" }
  });

  await runtime.start();
  await runtime.stop();
  await writeDaemonStatus(runtime.paths, {
    state: "failed",
    pid: null,
    restartAttempts: policy.restartLimit + 1,
    restartRequested: false,
    message: "Legacy global registration"
  });

  const supervisor = createToolProcessSupervisor({ policy, toolRegistry: registry });
  const results = await supervisor.repair();
  const result = results.find((item) => item.record.toolName === "fake-daemon" && item.record.instanceId === "global");

  assert.equal(result.outcome, "stale-registration");
  assert.match(result.reason, /global scope does not match manifest chat scope/);
  assert.equal(isProcessAlive(await runtime.getPid()), false);

  await unregisterManagedDaemon({ toolName: "fake-daemon", scope: { type: "global" } });
  assert.deepEqual(await readJson(runtime.paths.metaFile, null), null);
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

test("describes an intentionally stopped on-demand daemon without treating it as a failure", async () => {
  const runtime = runtimeFor({ type: "global" }, { autoStart: false });
  await writeDaemonStatus(runtime.paths, {
    state: "stopped",
    pid: null,
    message: "Idle timeout reached",
    restartAttempts: 0,
    restartRequested: false
  });

  const diagnostic = await readDaemonDiagnostic(runtime.registration);
  assert.equal(diagnostic.state, "stopped");
  assert.equal(diagnostic.disposition, "leave-stopped");
  assert.equal(diagnostic.lastError, null);
});

test("keeps auto-start ingress daemons in bounded backoff after the burst retry limit", async () => {
  const runtime = runtimeFor({ type: "global" }, { autoStart: true });
  await writeDaemonStatus(runtime.paths, {
    state: "starting",
    pid: null,
    message: "Network unavailable during boot",
    restartAttempts: policy.restartLimit,
    restartRequested: false,
    lastError: { phase: "health", message: "connect ENETUNREACH" }
  });

  assert.equal(await superviseDaemon(runtime.registration, policy), "restart-scheduled");
  const status = await readJson(runtime.paths.statusFile, {});
  assert.equal(status.state, "restarting");
  assert.equal(status.restartAttempts, policy.restartLimit);
  assert.equal(status.restartRequested, true);
  assert.ok(Date.parse(status.nextRestartAt) > Date.now());
});

test("keeps a terminal daemon failure stable until it receives explicit attention", async () => {
  const runtime = runtimeFor({ type: "global" }, { autoStart: true });
  await writeDaemonStatus(runtime.paths, {
    state: "failed",
    pid: null,
    message: "Daemon restart limit reached: synthetic crash",
    restartAttempts: policy.restartLimit + 1,
    restartRequested: false,
    nextRestartAt: null,
    lastError: { phase: "restart", message: "synthetic crash token=private-value", code: "SYNTHETIC" }
  });

  assert.equal(await superviseDaemon(runtime.registration, policy), "failed");
  assert.equal(await superviseDaemon(runtime.registration, policy), "failed");
  const status = await readJson(runtime.paths.statusFile, {});
  assert.equal(status.restartAttempts, policy.restartLimit + 1);

  const diagnostic = await readDaemonDiagnostic(runtime.registration);
  assert.equal(diagnostic.disposition, "requires-attention");
  assert.equal(diagnostic.lastError.code, "SYNTHETIC");
  assert.equal(diagnostic.lastError.message, "synthetic crash token=[redacted]");
  assert.match(
    formatDaemonOutcome(runtime.registration, "failed", diagnostic, policy),
    /failed \| error\[restart\]=synthetic crash token=\[redacted\] \| code=SYNTHETIC \| restarts=3\/2 \| action=requires-attention \| log=/
  );
});

test("doctor repair gives a terminal daemon one explicit restart attempt", async () => {
  const runtime = runtimeFor({ type: "global" }, { autoStart: true });
  await writeDaemonStatus(runtime.paths, {
    state: "failed",
    pid: null,
    message: "Daemon restart limit reached",
    restartAttempts: policy.restartLimit + 1,
    restartRequested: false
  });
  const supervisor = createToolProcessSupervisor({ policy });

  try {
    const results = await supervisor.repair();
    const result = results.find((item) => item.record.toolName === "fake-daemon" && item.record.instanceId === "global");
    assert.equal(result.outcome, "started");
    assert.equal((await readJson(runtime.paths.statusFile, {})).restartAttempts, 0);
    assert.equal(isProcessAlive(await runtime.getPid()), true);
  } finally {
    await runtime.stop().catch(() => {});
  }
});

test("includes scoped daemon diagnostics when Arisa lists tools", async () => {
  const runtime = runtimeFor({ type: "chat", chatId: "101" }, { autoStart: false });
  await writeDaemonStatus(runtime.paths, {
    state: "stopped",
    pid: null,
    message: "Idle timeout reached",
    restartAttempts: 0,
    restartRequested: false
  });
  const registry = new ToolRegistry();
  registry.tools.set("fake-daemon", {
    name: "fake-daemon",
    description: "Fake daemon",
    input: [],
    output: [],
    configSchema: {},
    category: null,
    keywords: [],
    skillHints: [],
    daemon: { scope: "chat", autoStart: false, health: "internal" }
  });

  const [tool] = await registry.listWithRuntime("101");
  assert.equal(tool.daemon.scope, "chat");
  assert.equal(tool.daemon.runtime.state, "stopped");
  assert.equal(tool.daemon.runtime.disposition, "leave-stopped");
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
