import { access } from "node:fs/promises";
import { superviseDaemon } from "../core/tools/daemon-health.js";
import { listRegisteredDaemons } from "../core/tools/daemon-processes.js";
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

export function createToolProcessSupervisor({ logger, policy } = {}) {
  let running = false;
  let timer = null;
  let reconciliation = null;
  let daemonPolicy = policy;

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
        if (outcome !== "healthy") {
          logger?.log("tools", `${record.toolName} (${record.instanceId || "global"}): ${outcome}`);
        }
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
