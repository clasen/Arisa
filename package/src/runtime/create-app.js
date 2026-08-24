import { loadConfig, saveConfig, updateConfig } from "../core/config/config-store.js";
import { ArtifactStore } from "../core/artifacts/artifact-store.js";
import { ToolRegistry } from "../core/tools/tool-registry.js";
import { TaskStore } from "../core/tasks/task-store.js";
import { AgentManager } from "../core/agent/agent-manager.js";
import { createCapabilityService } from "../core/capabilities/capability-service.js";
import { getErrorMessage, getPiAuthIssue } from "../core/agent/auth-flow.js";
import { createTelegramBot } from "../transport/telegram/bot.js";
import { createToolProcessSupervisor } from "./tool-process-supervisor.js";
import { createArisaCapabilities } from "./arisa-capabilities.js";
import { createIpcServer } from "./ipc/ipc-server.js";
import { getAgentConfig } from "../core/agent/model-selection.js";
import { normalizeModelSpeed } from "../core/agent/model-speed.js";
import { runDoctor } from "./doctor.js";
import { checkForUpdates, installCoreUpdate, updateOfficialTools } from "./update-manager.js";

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
  const unsupportedNamespaces = Object.keys(runtimeOverrides || {}).filter((name) => name !== "pi");
  if (unsupportedNamespaces.length) {
    throw new Error(`Unsupported runtime override namespace: ${unsupportedNamespaces.join(", ")}`);
  }
  const piRuntimeOverrides = runtimeOverrides?.pi || {};
  const pi = {};
  const providerOverride = normalizeString(piRuntimeOverrides.provider);
  const modelOverride = normalizeString(piRuntimeOverrides.model);

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
  if (piRuntimeOverrides.speed !== undefined) pi.speed = normalizeModelSpeed(piRuntimeOverrides.speed);

  if (!Object.keys(pi).length) return config;

  return {
    ...config,
    pi: {
      ...config.pi,
      ...pi
    }
  };
}

export async function createApp({ logger, runtimeOverrides, requestRestart } = {}) {
  if (typeof requestRestart !== "function") {
    throw new Error("createApp requires a service restart handoff");
  }
  logger?.log("app", "loading config");
  const persistedConfig = await loadConfig();
  const overriddenConfig = applyRuntimeOverrides(persistedConfig, runtimeOverrides);
  const config = overriddenConfig;
  const activeConfig = getAgentConfig(config);
  const persistedActiveConfig = getAgentConfig(persistedConfig);
  if (activeConfig.provider !== persistedActiveConfig.provider || activeConfig.model !== persistedActiveConfig.model) {
    logger?.log("app", `applying runtime model override: ${persistedActiveConfig.provider}/${persistedActiveConfig.model} -> ${activeConfig.provider}/${activeConfig.model}`);
  }

  const artifactStore = new ArtifactStore();
  const toolRegistry = new ToolRegistry({ logger, executionPolicy: config.toolExecution });
  const toolProcessSupervisor = createToolProcessSupervisor({ logger, policy: config.daemons, toolRegistry });
  const taskStore = new TaskStore();
  await toolRegistry.load();
  logger?.log("app", `loaded ${toolRegistry.list().length} tools`);

  const agentManager = new AgentManager({ config, artifactStore, toolRegistry, taskStore, logger });
  const capabilityService = createCapabilityService({
    artifactStore,
    taskStore,
    toolRegistry,
    toolExecutor: agentManager,
    logger
  });
  agentManager.setCapabilityService(capabilityService);
  const arisaCapabilities = createArisaCapabilities({ capabilityService });
  const ipcServer = createIpcServer({ capabilities: arisaCapabilities, logger });
  const bot = await createTelegramBot({
    config,
    artifactStore,
    toolRegistry,
    taskStore,
    agentManager,
    saveConfig,
    updateConfig,
    doctor: () => runDoctor({
      agentManager,
      toolProcessSupervisor,
      daemonPolicy: config.daemons,
      doctorPolicy: config.doctor,
      inspectToolDependencies: async () => toolRegistry.dependencyIssues(),
      inspectInfrastructure: async () => {
        const tool = toolRegistry.get("master-slave");
        if (!tool) return null;
        const result = await toolRegistry.run({
          name: "master-slave",
          request: { args: { action: "master.status" } }
        });
        return result.ok ? result.output?.json || null : { error: result.error };
      },
      logger
    }),
    checkUpdates: async (chatId) => checkForUpdates({ chatId, toolRegistry }),
    updateCore: async (targetVersion) => installCoreUpdate({ targetVersion }),
    updateTools: async (chatId) => updateOfficialTools({ chatId, toolRegistry }),
    requestRestart,
    logger
  });

  return {
    async start() {
      logger?.log("app", `validating Pi model ${activeConfig.provider}/${activeConfig.model}`);
      let skipAgentStartupPrompts = false;
      try {
        await agentManager.validateAgent();
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
        const recoveredTasks = await taskStore.recoverInterrupted();
        if (recoveredTasks.length) {
          logger?.log("tasks", `recovered ${recoveredTasks.length} interrupted task(s)`);
        }
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
      await agentManager.close();
      await toolProcessSupervisor.stop();
      await ipcServer.stop();
    }
  };
}
