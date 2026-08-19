import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import { promisify } from "node:util";
import { stopManagedDaemon, unregisterManagedDaemon } from "../core/tools/daemon-processes.js";
import { getServiceStatus, serviceEntryFile } from "./service-manager.js";
import { arisaHomeDir } from "./paths.js";
import { renderTextReport, reportRow, wrapReportText } from "./report-format.js";

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

function isArisaServiceProcess(record) {
  return record.command.includes(serviceEntryFile)
    && /(?:^|\s)--service-runner(?:\s|$)/.test(record.command);
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

function daemonState(result) {
  return result.diagnostic?.state || result.outcome;
}

function daemonStateLabel(state) {
  return String(state || "unknown")
    .split("-")
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

function daemonReportLines(results) {
  const priority = ["ready", "starting", "degraded", "unhealthy", "restarting", "stopped", "failed"];
  const groups = new Map();
  for (const result of results) {
    const state = daemonState(result);
    if (!groups.has(state)) groups.set(state, []);
    groups.get(state).push(result);
  }
  const states = [...groups.keys()].sort((left, right) => {
    const leftIndex = priority.indexOf(left);
    const rightIndex = priority.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
  const lines = [];
  for (const state of states) {
    const group = groups.get(state);
    lines.push(`  ${daemonStateLabel(state)} (${group.length})`);
    for (const result of group.sort((left, right) => daemonLabel(left.record).localeCompare(daemonLabel(right.record)))) {
      const scope = result.record.scope?.type || (result.record.instanceId === "global" ? "global" : "chat");
      lines.push(...wrapReportText(`${result.record.toolName} [${scope}]`, { firstPrefix: "  - ", nextPrefix: "    " }));
    }
  }
  return lines;
}

function formatTokenCount(tokens) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(tokens);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`].filter(Boolean).join(" ");
}

function masterSlaveMode(infrastructure) {
  const parts = [infrastructure.role || "unknown", infrastructure.daemon?.state || "unknown"];
  if (infrastructure.paired != null) parts.push(infrastructure.paired ? "paired" : "unpaired");
  return parts.join(" · ");
}

function masterSlaveActivity(jobs) {
  const active = jobs?.active;
  const queued = jobs?.queued;
  const failed = jobs?.failed;
  if ([active, queued, failed].every((value) => value === 0)) return "idle";
  return `${active ?? "?"} active · ${queued ?? "?"} queued · ${failed ?? "?"} failed`;
}

function compactEndpoint(endpoint) {
  return String(endpoint || "not configured").replace(/^tcp:\/\//, "");
}

export async function inspectSystemResources({ diskPath = arisaHomeDir } = {}) {
  const [load1, load5, load15] = os.loadavg();
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const filesystem = await statfs(diskPath);
  const blockSize = Number(filesystem.bsize);
  const diskTotal = Number(filesystem.blocks) * blockSize;
  const diskFree = Number(filesystem.bavail) * blockSize;
  return {
    platform: `${os.platform()} ${os.arch()}`,
    cpuCores: os.cpus().length,
    loadAverage: [load1, load5, load15],
    memoryTotal,
    memoryFree,
    memoryUsed: memoryTotal - memoryFree,
    diskTotal,
    diskFree,
    diskUsed: diskTotal - diskFree,
    uptimeSeconds: os.uptime(),
    processRss: process.memoryUsage().rss
  };
}

function assertDoctorPolicy(policy) {
  const positiveValues = [
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

export function formatDoctorReport(report) {
  const status = report.attention.length
    ? "attention needed"
    : report.repairs.length ? "repaired" : "healthy";
  const measured = report.contexts.filter((context) => Number.isFinite(context.percent));
  const large = report.contexts.filter((context) => context.level === "warning" || context.level === "critical").length;
  const inefficient = report.contexts.filter((context) => context.inefficiencies.length).length;
  const lines = ["Arisa Doctor", "============"];
  lines.push(...reportRow("Status", status));
  lines.push("", "Core");
  lines.push(...reportRow("Runtime", "Pi"));
  lines.push(...reportRow("Sessions", `${report.runtime.sessions} active / ${report.runtime.closingSessions} closing`));
  lines.push(...reportRow("Contexts", `${report.contexts.length} active / ${measured.length} measured`));
  lines.push(...reportRow("Large", large));
  lines.push(...reportRow("Ineff.", inefficient));
  if (measured.length) lines.push(...reportRow("Max", `${Math.max(...measured.map((context) => context.percent)).toFixed(1)}%`));
  lines.push("", `Daemons (${report.daemons.length})`);
  if (report.daemons.length) lines.push(...daemonReportLines(report.daemons));
  if (report.infrastructure) {
    lines.push("", "Master/Slave");
    if (report.infrastructure.error) {
      lines.push(...reportRow("Status", `unavailable: ${report.infrastructure.error}`));
    } else {
      lines.push(...reportRow("Mode", masterSlaveMode(report.infrastructure)));
      lines.push(...reportRow("Endpoint", compactEndpoint(report.infrastructure.endpoint)));
      lines.push(...reportRow("Activity", masterSlaveActivity(report.infrastructure.jobs)));
      lines.push(...reportRow("Tools", report.infrastructure.toolCount ?? "unknown"));
      lines.push(...reportRow("Secrets", `${report.infrastructure.pendingSecrets ?? "unknown"} pending`));
    }
  }
  if (report.system) {
    const memoryPercent = report.system.memoryTotal ? (report.system.memoryUsed / report.system.memoryTotal) * 100 : 0;
    const diskPercent = report.system.diskTotal ? (report.system.diskUsed / report.system.diskTotal) * 100 : 0;
    lines.push("", "System");
    lines.push(...reportRow("Host", report.system.platform));
    lines.push(...reportRow("Uptime", formatUptime(report.system.uptimeSeconds)));
    lines.push(...reportRow("CPU", `${report.system.cpuCores} cores`));
    lines.push(...reportRow("Load", report.system.loadAverage.map((value) => value.toFixed(2)).join(" / ")));
    lines.push(...reportRow("Memory", `${memoryPercent.toFixed(1)}% / ${formatBytes(report.system.memoryFree)} free`));
    lines.push(...reportRow("Disk", `${diskPercent.toFixed(1)}% / ${formatBytes(report.system.diskFree)} free`));
    lines.push(...reportRow("Arisa RSS", formatBytes(report.system.processRss)));
  } else if (report.systemError) {
    lines.push("", "System");
    lines.push(...reportRow("Status", `unavailable: ${report.systemError}`));
  }
  lines.push("", `Repairs (${report.repairs.length})`);
  for (const item of report.repairs) lines.push(...wrapReportText(item, { firstPrefix: "  - ", nextPrefix: "    " }));
  lines.push("", `Attention (${report.attention.length})`);
  for (const item of report.attention) lines.push(...wrapReportText(item, { firstPrefix: "  - ", nextPrefix: "    " }));
  return renderTextReport(lines);
}

export async function runDoctor({
  agentManager,
  toolProcessSupervisor,
  daemonPolicy,
  doctorPolicy,
  logger,
  listProcesses = listSystemProcesses,
  stopProcess = terminateProcess,
  serviceStatus = getServiceStatus,
  stopDaemon = stopManagedDaemon,
  unregisterDaemon = unregisterManagedDaemon,
  inspectResources = inspectSystemResources,
  inspectInfrastructure = null,
  inspectToolDependencies = null
}) {
  assertDoctorPolicy(doctorPolicy);
  const runtime = await agentManager.getRuntimeDiagnostic();
  const report = {
    runtime,
    contexts: runtime.contexts.map((context) => evaluateContext(context, doctorPolicy)),
    daemons: [],
    repairs: [],
    attention: [],
    system: null,
    systemError: null,
    infrastructure: null
  };
  addContextAttention(report);
  if (inspectToolDependencies) {
    try {
      for (const issue of await inspectToolDependencies()) {
        const installed = issue.installedVersion ? `; installed ${issue.installedVersion}` : "";
        report.attention.push(`Tool dependency ${issue.type}: ${issue.tool} requires ${issue.dependency}@${issue.range || "valid"}${installed}.`);
      }
    } catch (error) {
      report.attention.push(`Tool dependency inspection failed: ${error?.message || error}`);
    }
  }
  if (inspectInfrastructure) {
    try {
      report.infrastructure = await inspectInfrastructure();
    } catch (error) {
      report.infrastructure = { error: error?.message || String(error) };
      report.attention.push(`Master/Slave inspection failed: ${report.infrastructure.error}`);
    }
  }
  try {
    report.system = await inspectResources();
  } catch (error) {
    report.systemError = error?.message || String(error);
    report.attention.push(`System resource inspection failed: ${report.systemError}`);
  }
  let processes = [];
  try {
    processes = await listProcesses({ timeoutMs: daemonPolicy.healthTimeoutMs });
  } catch (error) {
    report.attention.push(`Process inspection failed: ${error?.message || error}`);
  }

  const processByPid = new Map(processes.map((record) => [record.pid, record]));
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
