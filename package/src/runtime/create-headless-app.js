import { ArtifactStore } from "../core/artifacts/artifact-store.js";
import { loadConfig } from "../core/config/config-store.js";
import { TaskStore } from "../core/tasks/task-store.js";
import { ToolRegistry } from "../core/tools/tool-registry.js";
import { createDaemonRuntime } from "../core/tools/daemon-runtime.js";
import { createArisaCapabilities } from "./arisa-capabilities.js";
import { createHeadlessToolExecutor } from "./headless-tool-executor.js";
import { createIpcServer } from "./ipc/ipc-server.js";
import { createToolProcessSupervisor } from "./tool-process-supervisor.js";

export async function createHeadlessApp({
  logger,
  configLoader = loadConfig,
  artifactStoreFactory = () => new ArtifactStore(),
  taskStoreFactory = () => new TaskStore(),
  toolRegistryFactory = () => new ToolRegistry({ logger }),
  supervisorFactory = (options) => createToolProcessSupervisor(options),
  capabilitiesFactory = (options) => createArisaCapabilities(options),
  ipcServerFactory = (options) => createIpcServer(options)
} = {}) {
  logger?.log("app", "loading headless config");
  const config = await configLoader();
  const artifactStore = artifactStoreFactory();
  const taskStore = taskStoreFactory();
  const toolRegistry = toolRegistryFactory();
  await toolRegistry.load();
  const toolProcessSupervisor = supervisorFactory({ logger, policy: config.daemons, toolRegistry });
  const toolExecutor = createHeadlessToolExecutor({ artifactStore, taskStore, toolRegistry });
  const capabilities = capabilitiesFactory({
    artifactStore,
    taskStore,
    toolRegistry,
    agentManager: toolExecutor
  });
  const ipcServer = ipcServerFactory({ capabilities, logger });
  const autoStartedDaemons = [];

  async function startGlobalDaemons() {
    for (const listed of toolRegistry.list()) {
      const tool = toolRegistry.get(listed.name);
      if (!tool?.daemon?.autoStart || tool.daemon.scope === "chat") continue;
      const runtime = createDaemonRuntime({
        toolName: tool.name,
        entryPath: tool.entry,
        scope: { type: "global" },
        autoStart: true
      });
      await runtime.start();
      autoStartedDaemons.push(runtime);
    }
  }

  return {
    toolRegistry,
    toolProcessSupervisor,
    ipcServer,
    async start() {
      let ipcStarted = false;
      try {
        await ipcServer.start();
        ipcStarted = true;
        await taskStore.recoverInterrupted();
        await startGlobalDaemons();
        await toolProcessSupervisor.start();
        logger?.log("app", "Arisa Slave headless host started");
      } catch (error) {
        if (ipcStarted) await ipcServer.stop();
        throw error;
      }
    },
    async stop() {
      await toolProcessSupervisor.stop();
      await Promise.allSettled(autoStartedDaemons.splice(0).map((runtime) => runtime.stop()));
      await ipcServer.stop();
    }
  };
}
