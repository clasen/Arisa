import { loadConfig, saveConfig, updateConfig } from "../core/config/config-store.js";
import { ArtifactStore } from "../core/artifacts/artifact-store.js";
import { ToolRegistry } from "../core/tools/tool-registry.js";
import { TaskStore } from "../core/tasks/task-store.js";
import { AgentManager } from "../core/agent/agent-manager.js";
import { getErrorMessage, getPiAuthIssue } from "../core/agent/auth-flow.js";
import { createTelegramBot } from "../transport/telegram/bot.js";
import { createToolProcessSupervisor } from "./tool-process-supervisor.js";
import { createArisaCapabilities } from "./arisa-capabilities.js";
import { createIpcServer } from "./ipc/ipc-server.js";

function normalizeString(value) {
  const text = String(value ?? "").trim();
  return text ? text : "";
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => normalizeString(item))
      .filter(Boolean);
    return items.length ? [...new Set(items)] : undefined;
  }

  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length ? [...new Set(items)] : undefined;
  }

  return undefined;
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.floor(number);
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

export function applyRuntimeOverrides(config, runtimeOverrides) {
  const piRuntimeOverrides = runtimeOverrides?.pi || {};
  const pi = {};
  const providerOverride = normalizeString(runtimeOverrides?.pi?.provider);
  const modelOverride = normalizeString(runtimeOverrides?.pi?.model);

  if (providerOverride || modelOverride) {
    const splitOverride = modelOverride ? splitModelOverride(modelOverride) : null;
    pi.provider = providerOverride || splitOverride?.provider || config.pi.provider;
    pi.model = splitOverride && (!providerOverride || providerOverride === splitOverride.provider)
      ? splitOverride.model
      : (modelOverride || config.pi.model);
  }

  for (const key of ["apiKey", "workspaceDir", "shellPath"]) {
    const value = normalizeString(piRuntimeOverrides[key]);
    if (value) pi[key] = value;
  }

  const tools = normalizeStringList(piRuntimeOverrides.tools);
  if (tools) pi.tools = tools;

  const excludeTools = normalizeStringList(piRuntimeOverrides.excludeTools);
  if (excludeTools) pi.excludeTools = excludeTools;

  const shellTimeoutMs = normalizePositiveInteger(piRuntimeOverrides.shellTimeoutMs);
  if (shellTimeoutMs) pi.shellTimeoutMs = shellTimeoutMs;

  if (!Object.keys(pi).length) return config;

  return {
    ...config,
    pi: {
      ...config.pi,
      ...pi
    }
  };
}

export async function createApp({ logger, runtimeOverrides } = {}) {
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
  const arisaCapabilities = createArisaCapabilities({ artifactStore, taskStore, agentManager });
  const ipcServer = createIpcServer({ capabilities: arisaCapabilities, logger });
  const bot = await createTelegramBot({ config, artifactStore, toolRegistry, taskStore, agentManager, saveConfig, updateConfig, logger });

  return {
    async start() {
      logger?.log("app", `validating Pi model ${config.pi.provider}/${config.pi.model}`);
      let skipAgentStartupPrompts = false;
      try {
        await agentManager.validatePiAgent();
      } catch (error) {
        const issue = getPiAuthIssue(error);
        if (!issue) {
          throw error;
        }
        skipAgentStartupPrompts = true;
        logger?.error("app", `Pi auth validation failed; starting Telegram in auth recovery mode: ${getErrorMessage(error)}`);
        await bot.notifyPiAuthIssue?.(error);
      }
      let ipcStarted = false;
      let supervisorStarted = false;
      try {
        await ipcServer.start();
        ipcStarted = true;
        await toolProcessSupervisor.start();
        supervisorStarted = true;
        logger?.log("app", "starting Telegram bot");
        await bot.start({ skipAgentStartupPrompts });
      } catch (error) {
        if (supervisorStarted) await toolProcessSupervisor.stop();
        if (ipcStarted) await ipcServer.stop();
        throw error;
      }
    },

    async stop() {
      await bot.stop?.();
      await toolProcessSupervisor.stop();
      await ipcServer.stop();
    }
  };
}
