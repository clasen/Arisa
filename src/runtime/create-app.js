import { loadConfig, saveConfig, updateConfig } from "../core/config/config-store.js";
import { ArtifactStore } from "../core/artifacts/artifact-store.js";
import { ToolRegistry } from "../core/tools/tool-registry.js";
import { AgentManager } from "../core/agent/agent-manager.js";
import { createTelegramBot } from "../transport/telegram/bot.js";

export async function createApp() {
  const config = await loadConfig();
  const artifactStore = new ArtifactStore();
  const toolRegistry = new ToolRegistry();
  await toolRegistry.load();

  const agentManager = new AgentManager({ config, artifactStore, toolRegistry });
  const bot = await createTelegramBot({ config, artifactStore, toolRegistry, agentManager, saveConfig, updateConfig });

  return {
    async start() {
      await agentManager.validatePiAgent();
      await bot.start();
    }
  };
}
