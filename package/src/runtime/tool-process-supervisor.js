import { access } from "node:fs/promises";
import { superviseDaemon } from "../core/tools/daemon-health.js";
import { listRegisteredDaemons, readDaemonDiagnostic } from "../core/tools/daemon-processes.js";
import { loadDaemonPolicy } from "../core/tools/daemon-policy.js";
import { ensureArisaHome } from "./paths.js";

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

export function createToolProcessSupervisor({ logger, policy } = {}) {
  let running = false;
  let timer = null;
  let reconciliation = null;
  let daemonPolicy = policy;
  const reportedDiagnostics = new Map();

  function reportLoopError(error) {
    logger?.error?.("tools", `daemon supervisor loop failed: ${error?.message || error}`);
  }

  async function reconcileDaemons() {
    await ensureArisaHome();
    for (const record of await listRegisteredDaemons()) {
      if (!(await fileExists(record.entryPath))) {
        logger?.log("tools", `skipping daemon ${record.toolName}: missing entry ${record.entryPath}`);
        continue;
      }
      try {
        const outcome = await superviseDaemon(record, daemonPolicy);
        const key = `${record.toolName}:${record.instanceId || "global"}`;
        if (outcome === "healthy") {
          reportedDiagnostics.delete(key);
          continue;
        }
        const diagnostic = await readDaemonDiagnostic(record);
        const message = formatDaemonOutcome(record, outcome, diagnostic, daemonPolicy);
        if (reportedDiagnostics.get(key) === message) continue;
        reportedDiagnostics.set(key, message);
        logger?.log("tools", message);
      } catch (error) {
        logger?.error?.("tools", `daemon supervision failed for ${record.toolName}: ${error?.message || error}`);
      }
    }
  }

  async function runLoop() {
    if (!running || reconciliation) return;
    reconciliation = reconcileDaemons();
    try {
      await reconciliation;
    } finally {
      reconciliation = null;
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
    }
  };
}
