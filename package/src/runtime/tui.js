import { mkdir, readFile } from "node:fs/promises";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  defineTool,
  InteractiveMode,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../core/config/config-store.js";
import { buildPiToolPolicy } from "../core/agent/core-tools.js";
import { createModelSpeedController } from "../core/agent/model-speed.js";
import { clampModelThinkingLevel, createPiRuntime, hasProviderAuth } from "../core/agent/pi-runtime.js";
import { appendArisaAgentsFile, arisaAgentsFile } from "../core/agent/runtime-context.js";
import { createPiSettingsManager } from "../core/agent/agent-manager.js";
import { createArisaClient } from "../core/tools/ipc-client.js";
import { arisaHomeDir, tuiSessionsDir } from "../platform/paths.js";

const tuiToolNames = Object.freeze([
  "list_tools",
  "tool_help",
  "tool_skills",
  "set_tool_config",
  "run_tool",
  "list_scheduled_tasks",
  "cancel_scheduled_task",
  "cancel_all_scheduled_tasks"
]);

function jsonResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    details: result
  };
}

export function resolveTuiChatId(config) {
  const chatId = config?.telegram?.authorizedChatIds?.[0];
  if (chatId == null || !String(chatId).trim()) {
    throw new Error("arisa tui requires at least one authorized chat for scoped tools and artifacts");
  }
  return chatId;
}

export function createTuiCapabilityTools(client) {
  return [
    defineTool({
      name: "list_tools",
      label: "List tools",
      description: "List or search Arisa modular tools by capability.",
      parameters: Type.Object({ query: Type.Optional(Type.String()) }),
      execute: async (_id, params) => jsonResult(await client.tools.list(params))
    }),
    defineTool({
      name: "tool_help",
      label: "Tool help",
      description: "Show the CLI help for an Arisa modular tool.",
      parameters: Type.Object({ name: Type.String() }),
      execute: async (_id, params) => jsonResult(await client.tools.help(params))
    }),
    defineTool({
      name: "tool_skills",
      label: "Tool skills",
      description: "Show skill hints assigned to an Arisa modular tool.",
      parameters: Type.Object({ name: Type.String() }),
      execute: async (_id, params) => jsonResult(await client.tools.skills(params))
    }),
    defineTool({
      name: "set_tool_config",
      label: "Set tool config",
      description: "Write an Arisa tool config value in the owner chat scope.",
      parameters: Type.Object({ name: Type.String(), field: Type.String(), value: Type.String() }),
      execute: async (_id, params) => jsonResult(await client.tools.setConfig(params))
    }),
    defineTool({
      name: "run_tool",
      label: "Run tool",
      description: "Run an Arisa modular tool. Generated files remain owner-scoped artifacts; Telegram delivery is unavailable from TUI mode.",
      parameters: Type.Object({
        name: Type.String(),
        artifactId: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
        resourceId: Type.Optional(Type.String()),
        args: Type.Optional(Type.Record(Type.String(), Type.String()))
      }),
      execute: async (_id, params) => jsonResult(await client.tools.run(params, { timeoutMs: 900_000 }))
    }),
    defineTool({
      name: "list_scheduled_tasks",
      label: "List scheduled tasks",
      description: "List owner-scoped Arisa tasks.",
      parameters: Type.Object({
        status: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
      }),
      execute: async (_id, params) => jsonResult(await client.tasks.list(params))
    }),
    defineTool({
      name: "cancel_scheduled_task",
      label: "Cancel scheduled task",
      description: "Cancel one owner-scoped Arisa task.",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, params) => jsonResult(await client.tasks.cancel(params))
    }),
    defineTool({
      name: "cancel_all_scheduled_tasks",
      label: "Cancel all scheduled tasks",
      description: "Cancel all active owner-scoped Arisa tasks, including authentication-blocked tasks.",
      parameters: Type.Object({}),
      execute: async () => jsonResult(await client.tasks.cancelAll())
    })
  ];
}

function requiresProviderAuth(model) {
  if (typeof model?.baseUrl !== "string") return true;
  try {
    const hostname = new URL(model.baseUrl).hostname;
    return hostname !== "127.0.0.1" && hostname !== "localhost";
  } catch {
    return true;
  }
}

export async function createArisaTuiRuntime({ config, client, logger } = {}) {
  const chatId = resolveTuiChatId(config);
  const policy = buildPiToolPolicy({ config, customToolNames: tuiToolNames });
  const piRuntime = await createPiRuntime({ provider: config.pi.provider, apiKey: config.pi.apiKey });
  const model = piRuntime.getModel(config.pi.provider, config.pi.model);
  if (!model) throw new Error(`Model not found: ${config.pi.provider}/${config.pi.model}`);
  if (requiresProviderAuth(model) && !config.pi.apiKey && !hasProviderAuth(config.pi.provider, piRuntime)) {
    throw new Error(`No auth found for ${config.pi.provider}. Complete Arisa bootstrap first.`);
  }

  await mkdir(tuiSessionsDir, { recursive: true });
  const arisaAgentsContent = await readFile(arisaAgentsFile, "utf8");
  const customTools = createTuiCapabilityTools(client);
  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const settingsManager = createPiSettingsManager(config);
    const services = await createAgentSessionServices({
      cwd,
      agentDir: arisaHomeDir,
      modelRuntime: piRuntime,
      settingsManager,
      resourceLoaderOptions: {
        agentsFilesOverride: (current) => appendArisaAgentsFile(current, arisaAgentsContent)
      }
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      thinkingLevel: clampModelThinkingLevel(model, config.pi.thinkingLevel),
      tools: policy.tools,
      excludeTools: policy.excludeTools,
      customTools
    });
    const speedController = createModelSpeedController(created.session.agent.streamFunction, config.pi.speed);
    created.session.agent.streamFunction = speedController.streamFn;
    logger?.log("tui", `opened ${created.session.sessionFile || "in-memory session"} for owner scope ${chatId}`);
    return { ...created, services, diagnostics: services.diagnostics };
  };

  return createAgentSessionRuntime(createRuntime, {
    cwd: policy.workspaceDir,
    agentDir: arisaHomeDir,
    sessionManager: SessionManager.create(policy.workspaceDir, tuiSessionsDir)
  });
}

export async function runTui({ logger } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("arisa tui requires an interactive terminal");
  }
  const config = await loadConfig();
  const chatId = resolveTuiChatId(config);
  const client = createArisaClient({ toolName: "arisa-tui", chatId });
  try {
    await client.tools.list();
  } catch (error) {
    throw new Error(`arisa tui requires the Arisa background service: ${error instanceof Error ? error.message : String(error)}`);
  }

  const runtime = await createArisaTuiRuntime({ config, client, logger });
  const mode = new InteractiveMode(runtime, {
    migratedProviders: [],
    modelFallbackMessage: runtime.modelFallbackMessage,
    initialImages: [],
    initialMessages: [],
    verbose: false
  });
  try {
    await mode.run();
  } finally {
    await runtime.dispose();
  }
}
