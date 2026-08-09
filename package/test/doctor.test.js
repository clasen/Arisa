import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { formatDoctorReport, runDoctor } from "../src/runtime/doctor.js";
import { chatsDir } from "../src/runtime/paths.js";
import { serviceEntryFile } from "../src/runtime/service-manager.js";
import { telegramCommands } from "../src/transport/telegram/bot.js";

const daemonPolicy = {
  healthTimeoutMs: 1_000,
  stopTimeoutMs: 100
};

function agentDiagnostic(overrides = {}) {
  return {
    runtime: "prime",
    sessions: 1,
    startingSessions: 0,
    closingSessions: 0,
    managedProcessIds: [111],
    ...overrides
  };
}

function createDoctorDependencies({ runtime, processes = [], daemons = [], service = { running: false, pid: null } } = {}) {
  const stoppedProcesses = [];
  const stoppedDaemons = [];
  return {
    stoppedProcesses,
    stoppedDaemons,
    input: {
      agentManager: { getRuntimeDiagnostic: () => runtime || agentDiagnostic() },
      toolProcessSupervisor: { repair: async () => daemons },
      daemonPolicy,
      listProcesses: async () => processes,
      stopProcess: async (pid) => { stoppedProcesses.push(pid); },
      serviceStatus: async () => service,
      stopDaemon: async (identity) => { stoppedDaemons.push(identity); }
    }
  };
}

test("registers /doctor as a native Telegram command", () => {
  assert.equal(
    telegramCommands.some((command) => command.command === "doctor"),
    true
  );
});

test("stops only verified duplicate and orphaned Arisa processes", async () => {
  const dependencies = createDoctorDependencies({
    service: { running: true, pid: 333 },
    processes: [
      { pid: 111, command: `prime-agent --mode rpc --session-dir ${chatsDir}/1/state/prime-sessions/0` },
      { pid: 222, command: `prime-agent --mode rpc --session-dir ${chatsDir}/2/state/prime-sessions/0` },
      { pid: 333, command: `${process.execPath} ${serviceEntryFile} --service-runner` },
      { pid: 444, command: "prime-agent --mode rpc --session-dir /tmp/someone-else" }
    ]
  });

  const report = await runDoctor(dependencies.input);

  assert.deepEqual(dependencies.stoppedProcesses, [333, 222]);
  assert.deepEqual(report.repairs, [
    "Stopped duplicate Arisa service process 333.",
    "Stopped orphaned Prime RPC process 222."
  ]);
});

test("defers Prime orphan cleanup while session ownership is changing", async () => {
  const dependencies = createDoctorDependencies({
    runtime: agentDiagnostic({ startingSessions: 1, managedProcessIds: [] }),
    processes: [
      { pid: 222, command: `prime-agent --mode rpc --session-dir ${chatsDir}/2/state/prime-sessions/0` }
    ]
  });

  const report = await runDoctor(dependencies.input);

  assert.deepEqual(dependencies.stoppedProcesses, []);
  assert.match(report.attention[0], /deferred/);
});

test("stops a registered daemon only when its missing entry matches the process command", async () => {
  const record = {
    toolName: "removed-tool",
    instanceId: "global",
    scope: { type: "global" },
    entryPath: "/tmp/removed-tool/index.js"
  };
  const dependencies = createDoctorDependencies({
    processes: [{ pid: 555, command: `${process.execPath} ${record.entryPath} daemon` }],
    daemons: [{
      record,
      outcome: "missing-entry",
      diagnostic: { state: "ready", alive: true, pid: 555 }
    }]
  });

  const report = await runDoctor(dependencies.input);

  assert.deepEqual(dependencies.stoppedProcesses, [555]);
  assert.deepEqual(dependencies.stoppedDaemons, [{ toolName: "removed-tool", scope: { type: "global" } }]);
  assert.deepEqual(report.repairs, ["Stopped orphaned daemon removed-tool (global)."]);
});

test("leaves an unverifiable registered PID untouched", async () => {
  const record = {
    toolName: "removed-tool",
    instanceId: "global",
    scope: { type: "global" },
    entryPath: "/tmp/removed-tool/index.js"
  };
  const dependencies = createDoctorDependencies({
    processes: [{ pid: 555, command: "unrelated-worker" }],
    daemons: [{
      record,
      outcome: "missing-entry",
      diagnostic: { state: "ready", alive: true, pid: 555 }
    }]
  });

  const report = await runDoctor(dependencies.input);

  assert.deepEqual(dependencies.stoppedProcesses, []);
  assert.match(report.attention[0], /could not be verified/);
});

test("formats a concise doctor summary with repairs and attention items", () => {
  const text = formatDoctorReport({
    runtime: agentDiagnostic(),
    daemons: [{ outcome: "started", diagnostic: { state: "starting" } }],
    repairs: ["Restarted one daemon."],
    attention: ["One item still needs attention."]
  });

  assert.match(text, /^Arisa Doctor: attention needed/m);
  assert.match(text, /Core: Prime, 1 active session/);
  assert.match(text, /Repairs:\n- Restarted one daemon\./);
  assert.match(text, /Attention:\n- One item still needs attention\./);
});
