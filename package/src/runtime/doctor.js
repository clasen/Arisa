import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { stopManagedDaemon, unregisterManagedDaemon } from "../core/tools/daemon-processes.js";
import { chatsDir } from "./paths.js";
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

export function formatDoctorReport(report) {
  const status = report.attention.length
    ? "attention needed"
    : report.repairs.length ? "repaired" : "healthy";
  const runtime = report.runtime.runtime === "prime" ? "Prime" : "Pi";
  const lines = [
    `Arisa Doctor: ${status}`,
    `Core: ${runtime}, ${report.runtime.sessions} active session(s), ${report.runtime.startingSessions} starting, ${report.runtime.closingSessions} closing.`,
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
  logger,
  listProcesses = listSystemProcesses,
  stopProcess = terminateProcess,
  serviceStatus = getServiceStatus,
  stopDaemon = stopManagedDaemon,
  unregisterDaemon = unregisterManagedDaemon
}) {
  const runtime = agentManager.getRuntimeDiagnostic();
  const report = { runtime, daemons: [], repairs: [], attention: [] };
  let processes = [];
  try {
    processes = await listProcesses({ timeoutMs: daemonPolicy.healthTimeoutMs });
  } catch (error) {
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
