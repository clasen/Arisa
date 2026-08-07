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
import { getAgentConfig } from "../core/agent/model-selection.js";
import { resolvePrimeAgentRuntime } from "./prime-agent-installer.js";

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
  const runtime = normalizeString(runtimeOverrides?.agent?.runtime);
  if (runtime && !["pi", "prime"].includes(runtime)) {
    throw new Error(`Unsupported agent runtime: ${runtime}`);
  }
  const effectiveRuntime = runtime || config.agent?.runtime || "pi";
  const legacyPiRuntimeOverrides = runtimeOverrides?.pi || {};
  const piRuntimeOverrides = effectiveRuntime === "pi" ? legacyPiRuntimeOverrides : {};
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

  const primeRuntimeOverrides = runtimeOverrides?.prime || {};
  const legacyPrimeAliases = effectiveRuntime === "prime" ? legacyPiRuntimeOverrides : {};
  const primeSource = { ...legacyPrimeAliases, ...primeRuntimeOverrides };
  const prime = {};
  const primeProviderOverride = normalizeString(primeSource.provider);
  const primeModelOverride = normalizeString(primeSource.model);
  if (primeProviderOverride || primeModelOverride) {
    const splitOverride = primeModelOverride ? splitModelOverride(primeModelOverride) : null;
    prime.provider = primeProviderOverride || splitOverride?.provider || config.prime.provider;
    prime.model = splitOverride && (!primeProviderOverride || primeProviderOverride === splitOverride.provider)
      ? splitOverride.model
      : (primeModelOverride || config.prime.model);
  }
  for (const key of ["apiKey", "workspaceDir", "command", "version", "thinkingLevel"]) {
    const value = normalizeString(primeSource[key]);
    if (value) prime[key] = value;
  }
  const idleMinutes = normalizePositiveInteger(primeSource.idleMinutes);
  if (idleMinutes) prime.idleMinutes = idleMinutes;

  if (!Object.keys(pi).length && !Object.keys(prime).length && !runtime) return config;

  return {
    ...config,
    agent: {
      ...config.agent,
      runtime: effectiveRuntime
    },
    pi: {
      ...config.pi,
      ...pi
    },
    prime: {
      ...config.prime,
      ...prime
    }
  };
}

export async function prepareAgentRuntime(config, { logger, resolvePrimeImpl = resolvePrimeAgentRuntime } = {}) {
  if (config.agent?.runtime !== "prime") return config;
  const runtime = await resolvePrimeImpl({
    command: config.prime.command,
    version: config.prime.version,
    logger
  });
  return {
    ...config,
    prime: {
      ...config.prime,
      command: runtime.command,
      commandArgs: runtime.commandArgs,
      managedRuntime: runtime.managed,
      runtimeDir: runtime.runtimeDir,
      kernelVenvDir: runtime.kernelVenvDir
    }
  };
}

export async function createApp({ logger, runtimeOverrides } = {}) {
  logger?.log("app", "loading config");
  const persistedConfig = await loadConfig();
  const overriddenConfig = applyRuntimeOverrides(persistedConfig, runtimeOverrides);
  const config = await prepareAgentRuntime(overriddenConfig, { logger });
  const activeConfig = getAgentConfig(config);
  const persistedActiveConfig = getAgentConfig(persistedConfig);
  if (activeConfig.provider !== persistedActiveConfig.provider || activeConfig.model !== persistedActiveConfig.model) {
    logger?.log("app", `applying runtime model override: ${persistedActiveConfig.provider}/${persistedActiveConfig.model} -> ${activeConfig.provider}/${activeConfig.model}`);
  }
  if (config.agent.runtime === "prime" && runtimeOverrides?.pi && !runtimeOverrides?.prime) {
    logger?.log("app", "deprecated --pi.* flags are being used as --prime.* aliases; rename them before the next major release");
  }

  const artifactStore = new ArtifactStore();
  const toolProcessSupervisor = createToolProcessSupervisor({ logger, policy: config.daemons });
  const toolRegistry = new ToolRegistry({ logger });
  const taskStore = new TaskStore();
  await toolRegistry.load();
  logger?.log("app", `loaded ${toolRegistry.list().length} tools`);

  const agentManager = new AgentManager({ config, artifactStore, toolRegistry, taskStore, logger });
  const arisaCapabilities = createArisaCapabilities({ artifactStore, taskStore, toolRegistry, agentManager });
  const ipcServer = createIpcServer({ capabilities: arisaCapabilities, logger });
  const bot = await createTelegramBot({ config, artifactStore, toolRegistry, taskStore, agentManager, saveConfig, updateConfig, logger });

  return {
    async start() {
      logger?.log("app", `validating ${config.agent.runtime} model ${activeConfig.provider}/${activeConfig.model}`);
      let skipAgentStartupPrompts = false;
      try {
        await agentManager.validateAgent();
      } catch (error) {
        const issue = getPiAuthIssue(error);
        if (!issue) {
          throw error;
        }
        skipAgentStartupPrompts = true;
        logger?.error("app", `${config.agent.runtime} auth validation failed; starting Telegram in auth recovery mode: ${getErrorMessage(error)}`);
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
      await agentManager.close();
      await toolProcessSupervisor.stop();
      await ipcServer.stop();
    }
  };
}
