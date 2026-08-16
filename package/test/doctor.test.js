import assert from "node:assert/strict";
import test from "node:test";
import { formatDoctorReport, runDoctor } from "../src/runtime/doctor.js";
import { serviceEntryFile } from "../src/runtime/service-manager.js";

const doctorPolicy = {
  contextInspectionTimeoutMs: 1_000,
  contextWarningPercent: 70,
  contextCriticalPercent: 90,
  contextInefficientMinTokens: 32_000,
  contextToolResultWarningPercent: 60,
  contextSingleMessageWarningPercent: 50
};

const daemonPolicy = {
  healthTimeoutMs: 1_000,
  stopTimeoutMs: 1_000
};

function runtime(overrides = {}) {
  return {
    harness: "pi",
    sessions: 1,
    closingSessions: 0,
    managedProcessIds: [],
    contexts: [],
    ...overrides
  };
}

const system = {
  platform: "linux x64",
  cpuCores: 4,
  loadAverage: [0.25, 0.5, 0.75],
  memoryTotal: 8 * 1024 ** 3,
  memoryFree: 3 * 1024 ** 3,
  memoryUsed: 5 * 1024 ** 3,
  diskTotal: 100 * 1024 ** 3,
  diskFree: 40 * 1024 ** 3,
  diskUsed: 60 * 1024 ** 3,
  uptimeSeconds: 90061,
  processRss: 256 * 1024 ** 2
};

async function run({ diagnostic = runtime(), processes = [], service = { running: false }, repairs = [] } = {}) {
  const stopped = [];
  const report = await runDoctor({
    agentManager: { getRuntimeDiagnostic: async () => diagnostic },
    toolProcessSupervisor: { repair: async () => repairs },
    daemonPolicy,
    doctorPolicy,
    listProcesses: async () => processes,
    serviceStatus: async () => service,
    stopProcess: async (pid) => { stopped.push(pid); },
    stopDaemon: async () => {},
    unregisterDaemon: async () => {},
    inspectResources: async () => system
  });
  return { report, stopped };
}

test("reports Pi context size and retained-content inefficiency", async () => {
  const { report } = await run({
    diagnostic: runtime({
      contexts: [{
        chatId: "42",
        messages: 20,
        estimatedTokens: 40_000,
        toolResultPercent: 70,
        largestMessagePercent: 10,
        tokens: 80_000,
        contextWindow: 100_000,
        percent: 80
      }]
    })
  });

  assert.equal(report.contexts[0].level, "warning");
  assert.match(report.attention.join("\n"), /80,000\/100,000 tokens/);
  assert.match(report.attention.join("\n"), /tool results occupy 70\.0%/);
  const formatted = formatDoctorReport(report);
  assert.match(formatted, /Core\n  Runtime    Pi/);
  assert.match(formatted, /CPU        4 cores/);
  assert.match(formatted, /Load       0\.25 \/ 0\.50 \/ 0\.75/);
  assert.match(formatted, /Memory     62\.5% \/ 3\.0 GB free/);
  assert.match(formatted, /Disk       60\.0% \/ 40\.0 GB free/);
  assert.ok(formatted.split("\n").every((line) => [...line].length <= 35));
});

test("lists each checked daemon with its scope and state", async () => {
  const { report } = await run({
    repairs: [
      {
        record: { toolName: "master-slave", instanceId: "global", scope: { type: "global" } },
        diagnostic: { state: "ready" },
        outcome: "healthy"
      },
      {
        record: { toolName: "context-vault", instanceId: "chat-1", scope: { type: "chat" } },
        diagnostic: { state: "stopped" },
        outcome: "stopped"
      }
    ]
  });

  report.infrastructure = {
    role: "master",
    daemon: { state: "ready" },
    endpoint: "tcp://198.74.61.48:4719",
    paired: null,
    identityFingerprint: "unnecessarily-long-fingerprint",
    toolCount: 0,
    jobs: { active: 0, queued: 0, failed: 0 },
    pendingSecrets: 0
  };
  const formatted = formatDoctorReport(report);
  assert.match(formatted, /Daemons \(2\)\n  Ready \(1\)\n  - master-slave \[global\]/);
  assert.match(formatted, /  Stopped \(1\)\n  - context-vault \[chat\]/);
  assert.match(formatted, /Master\/Slave\n  Mode       master · ready/);
  assert.match(formatted, /Endpoint   198\.74\.61\.48:4719/);
  assert.match(formatted, /Activity   idle/);
  assert.doesNotMatch(formatted, /Identity|fingerprint|Paired/);
  assert.ok(formatted.split("\n").every((line) => [...line].length <= 35));
});

test("reports missing tool dependencies as attention items", async () => {
  const report = await runDoctor({
    agentManager: { getRuntimeDiagnostic: async () => runtime() },
    toolProcessSupervisor: { repair: async () => [] },
    daemonPolicy,
    doctorPolicy,
    listProcesses: async () => [],
    serviceStatus: async () => ({ running: false }),
    inspectResources: async () => system,
    inspectToolDependencies: async () => [{
      tool: "magnific-mcp",
      type: "missing",
      dependency: "mcp-client",
      range: "^0.1.0"
    }]
  });
  assert.match(report.attention.join("\n"), /magnific-mcp requires mcp-client@\^0\.1\.0/);
});

test("stops only a registered duplicate Arisa service with verified identity", async () => {
  const duplicatePid = 321;
  const { report, stopped } = await run({
    processes: [{ pid: duplicatePid, command: `${process.execPath} ${serviceEntryFile} --service-runner` }],
    service: { running: true, pid: duplicatePid }
  });

  assert.deepEqual(stopped, [duplicatePid]);
  assert.match(report.repairs.join("\n"), /Stopped duplicate Arisa service process 321/);
});

test("requires complete positive doctor context policy", async () => {
  await assert.rejects(
    runDoctor({
      agentManager: { getRuntimeDiagnostic: async () => runtime() },
      toolProcessSupervisor: { repair: async () => [] },
      daemonPolicy,
      doctorPolicy: { ...doctorPolicy, contextInspectionTimeoutMs: 0 }
    }),
    /positive contextInspectionTimeoutMs/
  );
});
