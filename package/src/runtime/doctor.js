import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { stopManagedDaemon, unregisterManagedDaemon } from "../core/tools/daemon-processes.js";
import { listHarnessTransitionPrimeOwners } from "./harness-transition-journal.js";
import {
  chatsDir,
  legacyPrimeDaemonSocketFile,
  legacyPrimeSupervisorRegistryDir,
  primeDaemonSocketFile,
  primeStateDir,
  primeSupervisorRegistryDir
} from "./paths.js";
import { getServiceStatus, serviceEntryFile } from "./service-manager.js";

const execFileAsync = promisify(execFile);

function parsePosixProcesses(output) {
  return String(output || "")
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }));
}

function parseWindowsProcesses(output) {
  const parsed = JSON.parse(output || "[]");
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records
    .filter((record) => record?.ProcessId && record?.CommandLine)
    .map((record) => ({ pid: Number(record.ProcessId), command: String(record.CommandLine) }));
}

export async function listSystemProcesses({ timeoutMs, platform = process.platform } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Doctor process inspection requires a positive timeoutMs");
  }
  if (platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    ], { timeout: timeoutMs, windowsHide: true });
    return parseWindowsProcesses(stdout);
  }
  const { stdout } = await execFileAsync("ps", ["-ww", "-axo", "pid=,command="], { timeout: timeoutMs });
  return parsePosixProcesses(stdout);
}

function includesArgument(command, name, value) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escapedName}(?:=|\\s+)${escapedValue}(?:\\s|$)`).test(command);
}

function isArisaServiceProcess(record) {
  return record.command.includes(serviceEntryFile)
    && /(?:^|\s)--service-runner(?:\s|$)/.test(record.command);
}

function isPrimeRpcProcess(record) {
  return includesArgument(record.command, "--mode", "rpc")
    && /(?:^|\s)--session-dir(?:=|\s+)/.test(record.command)
    && record.command.includes(chatsDir);
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isPrimeDaemonOwnerRecord(value) {
  return value?.version === 1
    && value.role === "supervisor"
    && typeof value.token === "string"
    && typeof value.generation === "string"
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && (value.processStartId === undefined || typeof value.processStartId === "string")
    && typeof value.socketPath === "string"
    && typeof value.descriptorDir === "string"
    && typeof value.agentDir === "string"
    && typeof value.appVersion === "string";
}

export async function listPrimeDaemonOwners({
  registryDirs = [primeSupervisorRegistryDir, legacyPrimeSupervisorRegistryDir]
} = {}) {
  const owners = [];
  for (const registryDir of new Set(registryDirs.map((item) => path.resolve(item)))) {
    let entries;
    try {
      entries = await readdir(registryDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(".owner")) continue;
      try {
        const record = JSON.parse(await readFile(path.join(registryDir, entry.name, "owner.json"), "utf8"));
        if (!isPrimeDaemonOwnerRecord(record)) continue;
        owners.push({
          registryDir,
          pid: record.pid,
          processStartId: record.processStartId,
          socketPath: record.socketPath,
          descriptorDir: record.descriptorDir,
          agentDir: record.agentDir,
          appVersion: record.appVersion
        });
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        if (registryDir === path.resolve(primeSupervisorRegistryDir)) throw error;
      }
    }
  }
  return owners;
}

export async function getSystemProcessStartId(pid, { timeoutMs, platform = process.platform } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process identity PID: ${pid}`);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Process identity inspection requires a positive timeoutMs");
  }
  if (platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      const startTime = stat.slice(commandEnd + 2).split(" ")[19];
      if (startTime) return `proc:${startTime}`;
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
    }
  }
  if (platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks`
      ], { timeout: timeoutMs, windowsHide: true });
      const ticks = stdout.trim();
      return /^\d+$/.test(ticks) ? `win:${ticks}` : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: timeoutMs });
    const startedAt = stdout.trim();
    return startedAt ? `ps:${startedAt}` : undefined;
  } catch {
    return undefined;
  }
}

export function isOwnedPrimeDaemon(owner) {
  if (path.resolve(owner.agentDir) !== path.resolve(primeStateDir)) return false;
  if (!isPathInside(primeStateDir, owner.descriptorDir)) return false;
  const registryDir = path.resolve(owner.registryDir);
  if (registryDir === path.resolve(primeSupervisorRegistryDir)) {
    return owner.socketPath === primeDaemonSocketFile;
  }
  return registryDir === path.resolve(legacyPrimeSupervisorRegistryDir)
    && owner.socketPath === legacyPrimeDaemonSocketFile;
}

function isPrimeDaemonProcess(record, owner) {
  return record.command.trim() === "prime-agent"
    || (includesArgument(record.command, "--mode", "daemon")
      && includesArgument(record.command, "--daemon-socket", owner.socketPath));
}

function isDaemonProcess(record, daemon) {
  return record.command.includes(daemon.entryPath)
    && /(?:^|\s)daemon(?:\s|$)/.test(record.command);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function terminateProcess(pid, { forceAfterMs } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error(`Refusing to terminate invalid doctor target: ${pid}`);
  }
  if (!Number.isFinite(forceAfterMs) || forceAfterMs <= 0) {
    throw new Error("Doctor process cleanup requires a positive forceAfterMs");
  }
  if (!isAlive(pid)) return false;
  process.kill(pid, "SIGTERM");
  const startedAt = Date.now();
  while (Date.now() - startedAt < forceAfterMs) {
    if (!isAlive(pid)) return true;
    await sleep(Math.min(100, forceAfterMs));
  }
  if (isAlive(pid)) process.kill(pid, "SIGKILL");
  return true;
}

function daemonLabel(record) {
  return `${record.toolName} (${record.instanceId || "global"})`;
}

function daemonResultSummary(results) {
  const states = new Map();
  for (const result of results) {
    const state = result.diagnostic?.state || result.outcome;
    states.set(state, (states.get(state) || 0) + 1);
  }
  return [...states.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");
}

function formatTokenCount(tokens) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(tokens);
}

function assertDoctorPolicy(policy) {
  const positiveValues = [
    "contextInspectionTimeoutMs",
    "primeShutdownTimeoutMs",
    "contextWarningPercent",
    "contextCriticalPercent",
    "contextInefficientMinTokens",
    "contextToolResultWarningPercent",
    "contextSingleMessageWarningPercent"
  ];
  for (const name of positiveValues) {
    if (!Number.isFinite(policy?.[name]) || policy[name] <= 0) {
      throw new Error(`Doctor configuration requires a positive ${name}`);
    }
  }
  if (policy.contextCriticalPercent <= policy.contextWarningPercent) {
    throw new Error("Doctor contextCriticalPercent must be greater than contextWarningPercent");
  }
}

function evaluateContext(context, policy) {
  if (context.error) return { ...context, level: "unknown", inefficiencies: [] };
  const percent = context.percent;
  const level = !Number.isFinite(percent)
    ? "unknown"
    : percent >= policy.contextCriticalPercent
      ? "critical"
      : percent >= policy.contextWarningPercent ? "warning" : "healthy";
  const inefficiencies = [];
  if (context.estimatedTokens >= policy.contextInefficientMinTokens) {
    if (context.toolResultPercent >= policy.contextToolResultWarningPercent) {
      inefficiencies.push(`tool results occupy ${context.toolResultPercent.toFixed(1)}% of retained content`);
    }
    if (context.largestMessagePercent >= policy.contextSingleMessageWarningPercent) {
      inefficiencies.push(`one message occupies ${context.largestMessagePercent.toFixed(1)}% of retained content`);
    }
  }
  return { ...context, level, inefficiencies };
}

function contextSummary(contexts) {
  if (!contexts.length) return "Contexts: no active contexts.";
  const measured = contexts.filter((context) => Number.isFinite(context.percent));
  const oversized = contexts.filter((context) => context.level === "warning" || context.level === "critical").length;
  const inefficient = contexts.filter((context) => context.inefficiencies.length).length;
  const unavailable = contexts.length - measured.length;
  const details = [
    `${contexts.length} active`,
    `${measured.length} measured`,
    `${oversized} large`,
    `${inefficient} inefficient`
  ];
  if (unavailable) details.push(`${unavailable} unavailable`);
  if (measured.length) {
    details.push(`max ${Math.max(...measured.map((context) => context.percent)).toFixed(1)}%`);
  }
  return `Contexts: ${details.join(", ")}.`;
}

function addContextAttention(report) {
  for (const context of report.contexts) {
    const label = `Chat ${context.chatId}`;
    if (context.error) {
      report.attention.push(`${label} context inspection failed: ${context.error}`);
      continue;
    }
    if (context.level === "warning" || context.level === "critical") {
      const size = context.tokens == null || context.contextWindow == null
        ? `${context.percent.toFixed(1)}% of its context window`
        : `${formatTokenCount(context.tokens)}/${formatTokenCount(context.contextWindow)} tokens (${context.percent.toFixed(1)}%)`;
      const severity = context.level === "critical" ? "critically large" : "large";
      report.attention.push(`${label} context is ${severity}: ${size}. Use /new to carry durable context into a fresh session.`);
    }
    if (context.inefficiencies.length) {
      report.attention.push(`${label} context may be inefficient: ${formatTokenCount(context.estimatedTokens)} estimated retained tokens; ${context.inefficiencies.join("; ")}.`);
    }
  }
}

async function repairOrphanedPrimeDaemons({
  report,
  runtime,
  processByPid,
  daemonPolicy,
  doctorPolicy,
  listOwners,
  listTransitionOwners,
  readProcessStartId,
  stopPrimeDaemon
}) {
  if (runtime.runtime === "prime" && runtime.sessions > 0) return;
  const owners = [];
  try {
    owners.push(...await listOwners());
  } catch (error) {
    report.attention.push(`Prime daemon ownership inspection failed: ${error?.message || error}`);
  }
  try {
    owners.push(...await listTransitionOwners());
  } catch (error) {
    report.attention.push(`Harness transition inspection failed: ${error?.message || error}`);
  }
  const inspected = new Set();
  for (const owner of owners) {
    if (!isOwnedPrimeDaemon(owner)) continue;
    const identity = `${owner.pid}:${owner.processStartId || "unknown"}`;
    if (inspected.has(identity)) continue;
    inspected.add(identity);
    const record = processByPid.get(owner.pid);
    if (!record) {
      if (owner.transitionId) continue;
      report.attention.push(`Arisa Prime daemon ownership for PID ${owner.pid} is stale; no matching process is running.`);
      continue;
    }
    if (!owner.processStartId || !isPrimeDaemonProcess(record, owner)) {
      report.attention.push(`Arisa Prime daemon process ${owner.pid} could not be verified and was left running.`);
      continue;
    }
    const currentStartId = await readProcessStartId(owner.pid, {
      timeoutMs: daemonPolicy.healthTimeoutMs
    });
    if (currentStartId !== owner.processStartId) {
      report.attention.push(`Arisa Prime daemon process ${owner.pid} changed identity and was left running.`);
      continue;
    }
    try {
      await stopPrimeDaemon(owner, { timeoutMs: doctorPolicy.primeShutdownTimeoutMs });
      const traced = owner.transitionId ? ` from harness transition ${owner.transitionId}` : "";
      report.repairs.push(`Stopped orphaned Arisa Prime daemon ${owner.pid}${traced} and its workers.`);
    } catch (error) {
      report.attention.push(`Orphaned Arisa Prime daemon ${owner.pid} could not be stopped: ${error?.message || error}`);
    }
  }
}

export function formatDoctorReport(report) {
  const status = report.attention.length
    ? "attention needed"
    : report.repairs.length ? "repaired" : "healthy";
  const runtime = report.runtime.runtime === "prime" ? "Prime" : "Pi";
  const lines = [
    `Arisa Doctor: ${status}`,
    `Core: ${runtime}, ${report.runtime.sessions} active session(s), ${report.runtime.startingSessions} starting, ${report.runtime.closingSessions} closing.`,
    contextSummary(report.contexts),
    `Daemons: ${report.daemons.length} checked${report.daemons.length ? ` (${daemonResultSummary(report.daemons)})` : ""}.`
  ];
  if (!report.repairs.length) lines.push("Processes: no unnecessary managed processes found.");
  if (report.repairs.length) {
    lines.push("", "Repairs:", ...report.repairs.map((item) => `- ${item}`));
  }
  if (report.attention.length) {
    lines.push("", "Attention:", ...report.attention.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

export async function runDoctor({
  agentManager,
  toolProcessSupervisor,
  daemonPolicy,
  doctorPolicy,
  stopPrimeDaemon,
  logger,
  listProcesses = listSystemProcesses,
  listOwners = listPrimeDaemonOwners,
  listTransitionOwners = listHarnessTransitionPrimeOwners,
  readProcessStartId = getSystemProcessStartId,
  stopProcess = terminateProcess,
  serviceStatus = getServiceStatus,
  stopDaemon = stopManagedDaemon,
  unregisterDaemon = unregisterManagedDaemon
}) {
  assertDoctorPolicy(doctorPolicy);
  const runtime = await agentManager.getRuntimeDiagnostic({
    contextInspectionTimeoutMs: doctorPolicy.contextInspectionTimeoutMs
  });
  const report = {
    runtime,
    contexts: runtime.contexts.map((context) => evaluateContext(context, doctorPolicy)),
    daemons: [],
    repairs: [],
    attention: []
  };
  addContextAttention(report);
  let processes = [];
  let processInspectionSucceeded = true;
  try {
    processes = await listProcesses({ timeoutMs: daemonPolicy.healthTimeoutMs });
  } catch (error) {
    processInspectionSucceeded = false;
    report.attention.push(`Process inspection failed: ${error?.message || error}`);
  }

  const processByPid = new Map(processes.map((record) => [record.pid, record]));
  const activePids = new Set([process.pid, ...runtime.managedProcessIds]);
  const currentService = await serviceStatus();
  if (currentService.running && currentService.pid !== process.pid) {
    const registered = processByPid.get(currentService.pid);
    if (registered && isArisaServiceProcess(registered)) {
      try {
        await stopProcess(currentService.pid, { forceAfterMs: daemonPolicy.stopTimeoutMs });
        report.repairs.push(`Stopped duplicate Arisa service process ${currentService.pid}.`);
      } catch (error) {
        report.attention.push(`Duplicate Arisa service process ${currentService.pid} could not be stopped: ${error?.message || error}`);
      }
    } else {
      report.attention.push(`Registered service process ${currentService.pid} could not be verified and was left running.`);
    }
  }

  if (runtime.startingSessions || runtime.closingSessions) {
    report.attention.push("Prime orphan cleanup was deferred while sessions are starting or closing; run /doctor again when they settle.");
  } else {
    for (const record of processes) {
      if (activePids.has(record.pid) || !isPrimeRpcProcess(record)) continue;
      try {
        await stopProcess(record.pid, { forceAfterMs: daemonPolicy.stopTimeoutMs });
        report.repairs.push(`Stopped orphaned Prime RPC process ${record.pid}.`);
      } catch (error) {
        report.attention.push(`Orphaned Prime RPC process ${record.pid} could not be stopped: ${error?.message || error}`);
      }
    }
    if (processInspectionSucceeded) {
      await repairOrphanedPrimeDaemons({
        report,
        runtime,
        processByPid,
        daemonPolicy,
        doctorPolicy,
        listOwners,
        listTransitionOwners,
        readProcessStartId,
        stopPrimeDaemon
      });
    }
  }

  try {
    report.daemons = await toolProcessSupervisor.repair();
  } catch (error) {
    report.attention.push(`Daemon reconciliation failed: ${error?.message || error}`);
  }
  for (const result of report.daemons) {
    const label = daemonLabel(result.record);
    if (result.outcome === "stale-registration") {
      const pid = result.diagnostic?.pid;
      const registered = pid ? processByPid.get(pid) : null;
      if (pid && (!registered || !isDaemonProcess(registered, result.record))) {
        report.attention.push(`${label} has a stale registration, but its live process identity could not be verified.`);
        continue;
      }
      try {
        if (pid) {
          await stopProcess(pid, { forceAfterMs: daemonPolicy.stopTimeoutMs });
          await stopDaemon(
            { toolName: result.record.toolName, scope: result.record.scope },
            { state: null }
          );
        }
        await unregisterDaemon({ toolName: result.record.toolName, scope: result.record.scope });
        report.repairs.push(`Removed stale daemon registration ${label}: ${result.reason}.`);
      } catch (error) {
        report.attention.push(`${label} stale registration could not be removed: ${error?.message || error}`);
      }
      continue;
    }
    if (result.outcome === "missing-entry") {
      const pid = result.diagnostic?.pid;
      const registered = pid ? processByPid.get(pid) : null;
      if (registered && isDaemonProcess(registered, result.record)) {
        try {
          await stopProcess(pid, { forceAfterMs: daemonPolicy.stopTimeoutMs });
          await stopDaemon(
            { toolName: result.record.toolName, scope: result.record.scope },
            { state: "failed", message: "Orphaned daemon stopped because its tool entry is missing" }
          );
          report.repairs.push(`Stopped orphaned daemon ${label}.`);
        } catch (error) {
          report.attention.push(`${label} could not be stopped: ${error?.message || error}`);
        }
      } else {
        report.attention.push(`${label} has a missing entry${pid ? "; its process identity could not be verified" : ""}.`);
      }
      continue;
    }
    if (["started", "recovered", "restart-scheduled"].includes(result.outcome)) {
      report.repairs.push(`${label}: ${result.outcome}.`);
    }
    if (result.outcome === "error") {
      report.attention.push(`${label}: daemon reconciliation failed.`);
    } else if (result.diagnostic?.disposition === "requires-attention") {
      report.attention.push(`${label}: ${result.diagnostic.message || result.diagnostic.state}.`);
    }
  }

  logger?.log("doctor", `completed with ${report.repairs.length} repair(s) and ${report.attention.length} attention item(s)`);
  return report;
}
