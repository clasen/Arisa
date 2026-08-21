import { createCapabilityService } from "../core/capabilities/capability-service.js";

const ipcMethods = new Set([
  "tools.list",
  "tools.help",
  "tools.skills",
  "tools.setConfig",
  "tools.setResourceNote",
  "tools.getResourceNote",
  "tools.run",
  "tools.installOfficial",
  "artifacts.createText",
  "artifacts.listRecent",
  "artifacts.get",
  "artifacts.deliver",
  "tasks.add",
  "tasks.list",
  "tasks.cancel",
  "tasks.cancelAll",
  "agent.enqueueEvent",
  "paths.getChatToolStateDir",
  "paths.getToolStateDir",
  "paths.getChatToolTmpDir",
  "paths.getToolTmpDir",
  "paths.getChatArtifactsDir"
]);

export function createArisaCapabilities({
  capabilityService,
  artifactStore,
  taskStore,
  toolRegistry,
  agentManager,
  resourceNotes,
  installOfficialTool,
  logger
} = {}) {
  const service = capabilityService || createCapabilityService({
    artifactStore,
    taskStore,
    toolRegistry,
    toolExecutor: agentManager,
    resourceNotes,
    installOfficialTool,
    logger
  });

  return {
    dispatch: ({ method, toolName, chatId = null, params = {} } = {}) => service.execute({
      method,
      actorToolName: toolName,
      chatId,
      params,
      context: {
        allowedMethods: ipcMethods,
        unknownMethodLabel: "IPC"
      }
    })
  };
}
