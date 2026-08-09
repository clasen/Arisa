import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { formatDoctorReport, listPrimeDaemonOwners, runDoctor } from "../src/runtime/doctor.js";
import {
  chatsDir,
  legacyPrimeDaemonSocketFile,
  legacyPrimeSupervisorRegistryDir,
  primeDaemonSocketFile,
  primeStateDir,
  primeSupervisorRegistryDir
} from "../src/runtime/paths.js";
import { serviceEntryFile } from "../src/runtime/service-manager.js";
import { telegramCommands } from "../src/transport/telegram/bot.js";

const daemonPolicy = {
  healthTimeoutMs: 1_000,
  stopTimeoutMs: 100
};

const doctorPolicy = {
  contextInspectionTimeoutMs: 500,
  primeShutdownTimeoutMs: 1_000,
  contextWarningPercent: 70,
  contextCriticalPercent: 90,
  contextInefficientMinTokens: 32_000,
  contextToolResultWarningPercent: 60,
  contextSingleMessageWarningPercent: 50
};

function agentDiagnostic(overrides = {}) {
  return {
    runtime: "prime",
    sessions: 1,
    startingSessions: 0,
    closingSessions: 0,
    managedProcessIds: [111],
    contexts: [],
    ...overrides
  };
}

function createDoctorDependencies({
  runtime,
  processes = [],
  primeOwners = [],
  transitionOwners = [],
  processStartIds = {},
  daemons = [],
  service = { running: false, pid: null }
} = {}) {
  const stoppedProcesses = [];
  const stoppedPrimeDaemons = [];
  const stoppedDaemons = [];
  const unregisteredDaemons = [];
  return {
    stoppedProcesses,
    stoppedPrimeDaemons,
    stoppedDaemons,
    unregisteredDaemons,
    input: {
      agentManager: { getRuntimeDiagnostic: () => runtime || agentDiagnostic() },
      toolProcessSupervisor: { repair: async () => daemons },
      daemonPolicy,
      doctorPolicy,
      listProcesses: async () => processes,
      listOwners: async () => primeOwners,
      listTransitionOwners: async () => transitionOwners,
      readProcessStartId: async (pid) => processStartIds[pid],
      stopProcess: async (pid) => { stoppedProcesses.push(pid); },
      stopPrimeDaemon: async (owner) => { stoppedPrimeDaemons.push(owner.socketPath); },
      serviceStatus: async () => service,
      stopDaemon: async (identity) => { stoppedDaemons.push(identity); },
      unregisterDaemon: async (identity) => { unregisteredDaemons.push(identity); }
    }
  };
}

function primeDaemonOwner(overrides = {}) {
  return {
    registryDir: primeSupervisorRegistryDir,
    pid: 555,
    processStartId: "ps:expected-start",
    socketPath: primeDaemonSocketFile,
    descriptorDir: `${primeStateDir}/daemon-workers/arisa`,
    agentDir: primeStateDir,
    appVersion: "0.7.1",
    ...overrides
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

test("reads Prime daemon ownership metadata without exposing its control token", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-doctor-owners-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryDir = path.join(root, "supervisor-owners");
  const ownerDir = path.join(registryDir, "daemon.owner");
  await mkdir(ownerDir, { recursive: true });
  await writeFile(path.join(ownerDir, "owner.json"), JSON.stringify({
    version: 1,
    role: "supervisor",
    token: "must-not-leak",
    generation: "generation-1",
    pid: 555,
    processStartId: "ps:expected-start",
    socketPath: primeDaemonSocketFile,
    descriptorDir: `${primeStateDir}/daemon-workers/arisa`,
    agentDir: primeStateDir,
    appVersion: "0.7.1"
  }));

  const owners = await listPrimeDaemonOwners({ registryDirs: [registryDir] });

  assert.deepEqual(owners, [{
    registryDir,
    pid: 555,
    processStartId: "ps:expected-start",
    socketPath: primeDaemonSocketFile,
    descriptorDir: `${primeStateDir}/daemon-workers/arisa`,
    agentDir: primeStateDir,
    appVersion: "0.7.1"
  }]);
  assert.equal("token" in owners[0], false);
});

test("stops title-only Prime daemons only with exact Arisa ownership and process identity", async () => {
  const dependencies = createDoctorDependencies({
    runtime: agentDiagnostic({ sessions: 0, managedProcessIds: [] }),
    processes: [
      { pid: 555, command: "prime-agent" },
      { pid: 556, command: "prime-agent" },
      { pid: 557, command: "prime-agent" },
      { pid: 558, command: "prime-agent" }
    ],
    primeOwners: [
      primeDaemonOwner(),
      primeDaemonOwner({
        registryDir: legacyPrimeSupervisorRegistryDir,
        pid: 556,
        processStartId: "ps:legacy-start",
        socketPath: legacyPrimeDaemonSocketFile
      }),
      primeDaemonOwner({
        pid: 557,
        processStartId: "ps:other-start",
        agentDir: "/tmp/another-prime-agent",
        descriptorDir: "/tmp/another-prime-agent/daemon-workers/other"
      }),
      primeDaemonOwner({ pid: 558, processStartId: "ps:old-start" })
    ],
    processStartIds: {
      555: "ps:expected-start",
      556: "ps:legacy-start",
      557: "ps:other-start",
      558: "ps:new-start"
    }
  });

  const report = await runDoctor(dependencies.input);

  assert.deepEqual(dependencies.stoppedPrimeDaemons, [
    primeDaemonSocketFile,
    legacyPrimeDaemonSocketFile
  ]);
  assert.deepEqual(report.repairs, [
    "Stopped orphaned Arisa Prime daemon 555 and its workers.",
    "Stopped orphaned Arisa Prime daemon 556 and its workers."
  ]);
  assert.equal(report.attention.some((item) => item.includes("558 changed identity")), true);
  assert.equal(report.attention.some((item) => item.includes("557")), false);
});

test("keeps the owned Prime daemon while an active Prime session uses it", async () => {
  const dependencies = createDoctorDependencies({
    processes: [{ pid: 555, command: "prime-agent" }],
    primeOwners: [primeDaemonOwner()],
    processStartIds: { 555: "ps:expected-start" }
  });

  const report = await runDoctor(dependencies.input);

  assert.deepEqual(dependencies.stoppedPrimeDaemons, []);
  assert.deepEqual(report.repairs, []);
});

test("uses a Prime-to-Pi harness trace when the live owner record is gone", async () => {
  const transitionId = "transition-prime-to-pi";
  const dependencies = createDoctorDependencies({
    runtime: agentDiagnostic({
      runtime: "pi",
      sessions: 0,
      managedProcessIds: []
    }),
    processes: [{ pid: 555, command: "prime-agent" }],
    transitionOwners: [primeDaemonOwner({ transitionId })],
    processStartIds: { 555: "ps:expected-start" }
  });

  const report = await runDoctor(dependencies.input);

  assert.deepEqual(dependencies.stoppedPrimeDaemons, [primeDaemonSocketFile]);
  assert.deepEqual(report.repairs, [
    `Stopped orphaned Arisa Prime daemon 555 from harness transition ${transitionId} and its workers.`
  ]);
});

test("ignores historical harness traces after their Prime process is gone", async () => {
  const dependencies = createDoctorDependencies({
    runtime: agentDiagnostic({ runtime: "pi", sessions: 0, managedProcessIds: [] }),
    transitionOwners: [primeDaemonOwner({ transitionId: "completed-transition" })]
  });

  const report = await runDoctor(dependencies.input);

  assert.deepEqual(report.repairs, []);
  assert.deepEqual(report.attention, []);
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

test("removes a stale daemon registration without restarting it", async () => {
  const record = {
    toolName: "whatsapp-web",
    instanceId: "global",
    scope: { type: "global" },
    entryPath: "/tmp/whatsapp-web/index.js"
  };
  const dependencies = createDoctorDependencies({
    daemons: [{
      record,
      outcome: "stale-registration",
      reason: "registered global scope does not match manifest chat scope",
      diagnostic: { state: "failed", alive: false, pid: null }
    }]
  });

  const report = await runDoctor(dependencies.input);

  assert.deepEqual(dependencies.stoppedProcesses, []);
  assert.deepEqual(dependencies.unregisteredDaemons, [{ toolName: "whatsapp-web", scope: { type: "global" } }]);
  assert.deepEqual(report.repairs, [
    "Removed stale daemon registration whatsapp-web (global): registered global scope does not match manifest chat scope."
  ]);
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

test("flags contexts that are too large or retain inefficient payloads", async () => {
  const dependencies = createDoctorDependencies({
    runtime: agentDiagnostic({
      contexts: [{
        chatId: "42",
        messages: 12,
        estimatedTokens: 48_000,
        tokens: 92_000,
        contextWindow: 100_000,
        percent: 92,
        toolResultPercent: 70,
        largestMessagePercent: 35
      }, {
        chatId: "43",
        messages: 4,
        estimatedTokens: 4_000,
        tokens: 12_000,
        contextWindow: 100_000,
        percent: 12,
        toolResultPercent: 10,
        largestMessagePercent: 40
      }]
    })
  });

  const report = await runDoctor(dependencies.input);
  const text = formatDoctorReport(report);

  assert.equal(report.contexts[0].level, "critical");
  assert.deepEqual(report.contexts[0].inefficiencies, [
    "tool results occupy 70.0% of retained content"
  ]);
  assert.match(text, /Contexts: 2 active, 2 measured, 1 large, 1 inefficient, max 92\.0%\./);
  assert.match(text, /Chat 42 context is critically large: 92,000\/100,000 tokens \(92\.0%\)/);
  assert.match(text, /Chat 42 context may be inefficient/);
  assert.doesNotMatch(text, /Chat 43 context/);
});

test("reports unavailable context measurements without treating post-compaction usage as unhealthy", async () => {
  const dependencies = createDoctorDependencies({
    runtime: agentDiagnostic({
      contexts: [{
        chatId: "42",
        messages: 2,
        estimatedTokens: 900,
        tokens: null,
        contextWindow: 100_000,
        percent: null,
        toolResultPercent: 0,
        largestMessagePercent: 70
      }]
    })
  });

  const report = await runDoctor(dependencies.input);

  assert.equal(report.contexts[0].level, "unknown");
  assert.deepEqual(report.attention, []);
  assert.match(formatDoctorReport(report), /1 unavailable/);
});

test("formats a concise doctor summary with repairs and attention items", () => {
  const text = formatDoctorReport({
    runtime: agentDiagnostic(),
    contexts: [],
    daemons: [{ outcome: "started", diagnostic: { state: "starting" } }],
    repairs: ["Restarted one daemon."],
    attention: ["One item still needs attention."]
  });

  assert.match(text, /^Arisa Doctor: attention needed/m);
  assert.match(text, /Core: Prime, 1 active session/);
  assert.match(text, /Repairs:\n- Restarted one daemon\./);
  assert.match(text, /Attention:\n- One item still needs attention\./);
});
