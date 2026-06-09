import crypto from "node:crypto";
import { access, rm } from "node:fs/promises";
import {
  daemonPaths,
  listRegisteredDaemons,
  readJson,
  startManagedDaemon,
  stopManagedDaemon,
  writeJson
} from "../core/tools/daemon-processes.js";
import { ensureArisaHome, toolDaemonOwnerFile } from "./paths.js";

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function createToolProcessSupervisor({ logger } = {}) {
  const token = crypto.randomUUID();
  let heartbeatTimer = null;
  let running = false;

  const ownerEnv = {
    ARISA_OWNER_PID: String(process.pid),
    ARISA_TOOL_OWNER_FILE: toolDaemonOwnerFile,
    ARISA_TOOL_OWNER_TOKEN: token
  };

  async function writeHeartbeat() {
    await writeJson(toolDaemonOwnerFile, {
      pid: process.pid,
      token,
      heartbeatAt: new Date().toISOString()
    });
  }

  async function startHeartbeat() {
    await ensureArisaHome();
    await writeHeartbeat();
    heartbeatTimer = setInterval(() => {
      writeHeartbeat().catch((error) => {
        logger?.error("tools", `tool daemon heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 2000);
    heartbeatTimer.unref();
  }

  async function restartRegisteredDaemons() {
    for (const record of await listRegisteredDaemons()) {
      if (!record.autoStart) continue;
      if (!(await fileExists(record.entryPath))) {
        logger?.log("tools", `skipping daemon ${record.toolName}: missing entry ${record.entryPath}`);
        continue;
      }

      const paths = daemonPaths(record.toolName);
      const { pid } = await readJson(paths.pidFile, {});
      if (pid) {
        await stopManagedDaemon(record.toolName);
      }

      logger?.log("tools", `starting managed daemon ${record.toolName}`);
      await startManagedDaemon({
        toolName: record.toolName,
        entryPath: record.entryPath,
        ownerEnv
      });
    }
  }

  async function stopRegisteredDaemons() {
    for (const record of await listRegisteredDaemons()) {
      logger?.log("tools", `stopping managed daemon ${record.toolName}`);
      await stopManagedDaemon(record.toolName);
    }
  }

  async function removeOwnerFile() {
    const current = await readJson(toolDaemonOwnerFile, null);
    if (current?.token === token) {
      await rm(toolDaemonOwnerFile, { force: true });
    }
  }

  return {
    env() {
      return ownerEnv;
    },

    async start() {
      if (running) return;
      running = true;
      await startHeartbeat();
      await restartRegisteredDaemons();
    },

    async stop() {
      if (!running) return;
      running = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      await stopRegisteredDaemons();
      await removeOwnerFile();
    }
  };
}
