import { loadConfig, saveConfig, updateConfig } from "../core/config/config-store.js";
import { ArtifactStore } from "../core/artifacts/artifact-store.js";
import { ToolRegistry } from "../core/tools/tool-registry.js";
import { TaskStore } from "../core/tasks/task-store.js";
import { AgentManager } from "../core/agent/agent-manager.js";
import { createTelegramBot } from "../transport/telegram/bot.js";
import { createToolProcessSupervisor } from "./tool-process-supervisor.js";

function normalizeString(value) {
  const text = String(value ?? "").trim();
  return text ? text : "";
}

function splitModelOverride(modelOverride) {
  const separatorIndex = modelOverride.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === modelOverride.length - 1) {
    return null;
  }
  return {
    provider: modelOverride.slice(0, separatorIndex),
    model: modelOverride.slice(separatorIndex + 1)
  };
}

function applyRuntimeOverrides(config, runtimeOverrides) {
  const providerOverride = normalizeString(runtimeOverrides?.pi?.provider);
  const modelOverride = normalizeString(runtimeOverrides?.pi?.model);
  if (!providerOverride && !modelOverride) return config;

  const splitOverride = modelOverride ? splitModelOverride(modelOverride) : null;
  const provider = providerOverride || splitOverride?.provider || config.pi.provider;
  const model = splitOverride && (!providerOverride || providerOverride === splitOverride.provider)
    ? splitOverride.model
    : (modelOverride || config.pi.model);

  return {
    ...config,
    pi: {
      ...config.pi,
      provider,
      model
    }
  };
}

export async function createApp({ logger, runtimeOverrides, webhookUrl, setHttpRequestHandler } = {}) {
  logger?.log("app", "loading config");
  const persistedConfig = await loadConfig();
  const config = applyRuntimeOverrides(persistedConfig, runtimeOverrides);
  if (config.pi.provider !== persistedConfig.pi.provider || config.pi.model !== persistedConfig.pi.model) {
    logger?.log("app", `applying runtime model override: ${persistedConfig.pi.provider}/${persistedConfig.pi.model} -> ${config.pi.provider}/${config.pi.model}`);
  }

  const artifactStore = new ArtifactStore();
  const toolProcessSupervisor = createToolProcessSupervisor({ logger });
  const toolRegistry = new ToolRegistry({ logger });
  const taskStore = new TaskStore();
  await toolRegistry.load();
  logger?.log("app", `loaded ${toolRegistry.list().length} tools`);

  const agentManager = new AgentManager({ config, artifactStore, toolRegistry, taskStore, logger });
  const bot = await createTelegramBot({ config, artifactStore, toolRegistry, taskStore, agentManager, saveConfig, updateConfig, logger, webhookUrl, setHttpRequestHandler });

  return {
    async start() {
      logger?.log("app", `validating Pi model ${config.pi.provider}/${config.pi.model}`);
      await agentManager.validatePiAgent();
      await toolProcessSupervisor.start();
      logger?.log("app", "starting Telegram bot");
      try {
        await bot.start();
      } catch (error) {
        await toolProcessSupervisor.stop();
        throw error;
      }
    },

    async stop() {
      await bot.stop?.();
      await toolProcessSupervisor.stop();
    }
  };
}
