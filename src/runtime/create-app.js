import { loadConfig, saveConfig, updateConfig } from "../core/config/config-store.js";
import { ArtifactStore } from "../core/artifacts/artifact-store.js";
import { ToolRegistry } from "../core/tools/tool-registry.js";
import { TaskStore } from "../core/tasks/task-store.js";
import { AgentManager } from "../core/agent/agent-manager.js";
import { createTelegramBot } from "../transport/telegram/bot.js";

export async function createApp({ logger } = {}) {
  logger?.log("app", "loading config");
  const config = await loadConfig();
  const artifactStore = new ArtifactStore();
  const toolRegistry = new ToolRegistry({ logger });
  const taskStore = new TaskStore();
  await toolRegistry.load();
  logger?.log("app", `loaded ${toolRegistry.list().length} tools`);

  const agentManager = new AgentManager({ config, artifactStore, toolRegistry, taskStore, logger });
  const bot = await createTelegramBot({ config, artifactStore, toolRegistry, taskStore, agentManager, saveConfig, updateConfig, logger });

  return {
    async start() {
      logger?.log("app", `validating Pi model ${config.pi.provider}/${config.pi.model}`);
      await agentManager.validatePiAgent();
      logger?.log("app", "starting Telegram bot");
      await bot.start();
    }
  };
}
