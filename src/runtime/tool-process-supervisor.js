import { access, rm } from "node:fs/promises";
import {
  daemonPaths,
  isProcessAlive,
  listRegisteredDaemons,
  readJson,
  startManagedDaemon
} from "../core/tools/daemon-processes.js";
import { ensureArisaHome } from "./paths.js";

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function createToolProcessSupervisor({ logger } = {}) {
  let running = false;

  async function reconcileDaemons() {
    await ensureArisaHome();
    for (const record of await listRegisteredDaemons()) {
      if (!record.autoStart) continue;
      if (!(await fileExists(record.entryPath))) {
        logger?.log("tools", `skipping daemon ${record.toolName}: missing entry ${record.entryPath}`);
        continue;
      }

      const paths = daemonPaths(record.toolName);
      const { pid } = await readJson(paths.pidFile, {});
      if (isProcessAlive(pid)) {
        logger?.log("tools", `adopted managed daemon ${record.toolName} (pid ${pid})`);
        continue;
      }
      if (pid) {
        await rm(paths.pidFile, { force: true });
        logger?.log("tools", `removed stale daemon pid for ${record.toolName} (${pid})`);
      }

      logger?.log("tools", `starting managed daemon ${record.toolName}`);
      await startManagedDaemon({
        toolName: record.toolName,
        entryPath: record.entryPath
      });
    }
  }

  return {
    async start() {
      if (running) return;
      running = true;
      await reconcileDaemons();
    },

    async stop() {
      if (!running) return;
      running = false;
    }
  };
}
