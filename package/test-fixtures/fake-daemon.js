import { fileURLToPath } from "node:url";
import {
  readDaemonLaunchContext,
  readJson,
  writeJson
} from "../src/core/tools/daemon-processes.js";
import { createDaemonRuntime } from "../src/core/tools/daemon-runtime.js";

const toolName = "fake-daemon";
const entryPath = fileURLToPath(import.meta.url);
const launch = await readDaemonLaunchContext({ expectedToolName: toolName });
const runtime = createDaemonRuntime({
  toolName,
  entryPath,
  scope: launch.scope,
  startupContext: launch.startupContext,
  autoStart: launch.autoStart
});

async function healthCheck() {
  if (launch.startupContext.health === "fail") {
    throw new Error("synthetic health failure");
  }
  if (launch.startupContext.health === "hang") {
    await new Promise(() => {});
  }
  return { message: "synthetic health passed" };
}

async function recover() {
  if (!launch.startupContext.recover) return false;
  await writeJson(`${runtime.paths.root}/recovered.json`, { recovered: true });
  launch.startupContext.health = "ok";
  return true;
}

if (process.argv[2] !== "daemon") {
  throw new Error("fake daemon only supports the daemon command");
}

await runtime.workLoop({
  healthCheck,
  recover,
  processJob: async (payload, execution) => {
    if (payload.action === "fail") throw new Error("synthetic job failure");
    if (payload.action === "hang-until-cancelled") {
      await new Promise((_, reject) => execution.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("synthetic job cancelled"), { code: "DAEMON_JOB_CANCELLED" }));
      }, { once: true }));
    }
    if (payload.action === "stream") {
      await execution.emit("progress", { percent: 50 });
      await execution.emit("chunk", { text: "partial" });
    }
    if (payload.action === "count") {
      const countFile = `${runtime.paths.root}/effects.json`;
      const current = await readJson(countFile, { count: 0 });
      await writeJson(countFile, { count: current.count + 1 });
      return { count: current.count + 1 };
    }
    return { echo: payload.value ?? null };
  }
});
