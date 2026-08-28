import { access } from "node:fs/promises";
import path from "node:path";
import { superviseDaemon } from "../core/tools/daemon-health.js";
import {
  daemonPaths,
  listRegisteredDaemons,
  readDaemonDiagnostic,
  writeDaemonStatus
} from "../core/tools/daemon-processes.js";
import { loadDaemonPolicy } from "../core/tools/daemon-policy.js";
import { ensureArisaHome } from "../platform/paths.js";
import { reapObsoleteDaemon } from "./obsolete-daemon-reaper.js";

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function formatDaemonOutcome(record, outcome, diagnostic, policy) {
  const details = [`${record.toolName} (${record.instanceId || "global"}): ${outcome}`];
  if (diagnostic.lastError?.message) {
    details.push(`error[${diagnostic.lastError.phase || "unknown"}]=${oneLine(diagnostic.lastError.message)}`);
    if (diagnostic.lastError.code) details.push(`code=${diagnostic.lastError.code}`);
  } else if (diagnostic.message) {
    details.push(`message=${oneLine(diagnostic.message)}`);
  }
  if (diagnostic.restart.attempts > 0) {
    details.push(`restarts=${diagnostic.restart.attempts}/${policy.restartLimit}`);
  }
  if (diagnostic.restart.nextAt) details.push(`next=${diagnostic.restart.nextAt}`);
  details.push(`action=${diagnostic.disposition}`);
  if (diagnostic.disposition === "requires-attention") details.push(`log=${diagnostic.logFile}`);
  return details.join(" | ");
}

function validateRegistration(record, toolRegistry) {
  if (!toolRegistry) return { valid: true, record };
  const tool = toolRegistry.get(record.toolName);
  if (!tool) return { valid: false, reason: "tool is no longer installed" };
  if (!tool.daemon) return { valid: false, reason: "tool no longer declares a daemon" };
  const expectedScope = tool.daemon.scope === "chat" ? "chat" : "global";
  if (record.scope?.type !== expectedScope) {
    return { valid: false, reason: `registered ${record.scope?.type || "unknown"} scope does not match manifest ${expectedScope} scope` };
  }
  if (path.resolve(record.entryPath) !== path.resolve(tool.entry)) {
    return { valid: false, reason: "registered entry does not match the installed tool" };
  }
  return {
    valid: true,
    record: { ...record, autoStart: Boolean(tool.daemon.autoStart) }
  };
}

export function createToolProcessSupervisor({
  logger,
  policy,
  toolRegistry,
  obsoleteDaemonReaper = reapObsoleteDaemon
} = {}) {
  let running = false;
  let timer = null;
  let reconciliation = null;
  let daemonPolicy = policy;
  const reportedDiagnostics = new Map();

  function reportLoopError(error) {
    logger?.error?.("tools", `daemon supervisor loop failed: ${error?.message || error}`);
  }

  async function reconcileDaemons({ repairFailed = false } = {}) {
    await ensureArisaHome();
    const results = [];
    for (const registeredRecord of await listRegisteredDaemons()) {
      const validation = validateRegistration(registeredRecord, toolRegistry);
      if (!validation.valid) {
        const diagnostic = await readDaemonDiagnostic(registeredRecord);
        try {
          const result = await obsoleteDaemonReaper({
            record: registeredRecord,
            diagnostic,
            reason: validation.reason,
            timeoutMs: daemonPolicy.healthTimeoutMs,
            stopTimeoutMs: daemonPolicy.stopTimeoutMs
          });
          results.push(result);
          const key = `${registeredRecord.toolName}:${registeredRecord.instanceId || "global"}`;
          const message = result.outcome === "obsolete-removed"
            ? `removed obsolete daemon ${registeredRecord.toolName} (${registeredRecord.instanceId || "global"}): ${validation.reason}`
            : `left obsolete daemon ${registeredRecord.toolName} (${registeredRecord.instanceId || "global"}) untouched because process identity could not be verified`;
          if (reportedDiagnostics.get(key) !== message) {
            reportedDiagnostics.set(key, message);
            logger?.log("tools", message);
          }
        } catch (error) {
          logger?.error?.("tools", `obsolete daemon cleanup failed for ${registeredRecord.toolName}: ${error?.message || error}`);
          results.push({
            record: registeredRecord,
            outcome: "obsolete-cleanup-error",
            reason: validation.reason,
            diagnostic,
            error: error?.message || String(error)
          });
        }
        continue;
      }
      const record = validation.record;
      if (!(await fileExists(record.entryPath))) {
        logger?.log("tools", `skipping daemon ${record.toolName}: missing entry ${record.entryPath}`);
        results.push({ record, outcome: "missing-entry", diagnostic: await readDaemonDiagnostic(record) });
        continue;
      }
      try {
        const current = await readDaemonDiagnostic(record);
        if (repairFailed && current.state === "failed") {
          await writeDaemonStatus(daemonPaths(record), {
            state: "restarting",
            pid: null,
            heartbeatAt: null,
            restartAttempts: 0,
            restartRequested: true,
            nextRestartAt: null,
            message: "Manual repair requested by /doctor"
          });
        }
        const outcome = await superviseDaemon(record, daemonPolicy);
        const key = `${record.toolName}:${record.instanceId || "global"}`;
        if (outcome === "healthy") {
          reportedDiagnostics.delete(key);
          results.push({ record, outcome, diagnostic: await readDaemonDiagnostic(record) });
          continue;
        }
        const diagnostic = await readDaemonDiagnostic(record);
        results.push({ record, outcome, diagnostic });
        const message = formatDaemonOutcome(record, outcome, diagnostic, daemonPolicy);
        if (reportedDiagnostics.get(key) === message) continue;
        reportedDiagnostics.set(key, message);
        logger?.log("tools", message);
      } catch (error) {
        logger?.error?.("tools", `daemon supervision failed for ${record.toolName}: ${error?.message || error}`);
        results.push({ record, outcome: "error", error: error?.message || String(error) });
      }
    }
    return results;
  }

  async function runReconciliation(options) {
    while (reconciliation) await reconciliation.catch(() => {});
    const current = reconcileDaemons(options);
    reconciliation = current;
    try {
      return await current;
    } finally {
      if (reconciliation === current) reconciliation = null;
    }
  }

  async function runLoop() {
    if (!running) return;
    try {
      await runReconciliation();
    } finally {
      if (running) {
        timer = setTimeout(() => {
          runLoop().catch(reportLoopError);
        }, daemonPolicy.supervisorIntervalMs);
      }
    }
  }

  return {
    async start() {
      if (running) return;
      daemonPolicy ||= await loadDaemonPolicy();
      running = true;
      runLoop().catch(reportLoopError);
    },

    async stop() {
      if (!running) return;
      running = false;
      clearTimeout(timer);
      timer = null;
      await reconciliation?.catch(() => {});
    },

    async repair() {
      daemonPolicy ||= await loadDaemonPolicy();
      return runReconciliation({ repairFailed: true });
    }
  };
}
