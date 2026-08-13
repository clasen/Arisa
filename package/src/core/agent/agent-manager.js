import path from "node:path";
import { readFile, stat, unlink } from "node:fs/promises";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createPiRuntime, hasProviderAuth } from "./pi-runtime.js";
import { resolveChatModelSelection } from "./model-selection.js";
import { appendArisaAgentsFile, arisaAgentsFile, arisaInstallDir, buildAgentRuntimeContext } from "./runtime-context.js";
import { withTimeout } from "./prompt-timeout.js";
import { buildPiToolPolicy, getCoreCodingTools } from "./core-tools.js";
import { createSystemShellTool } from "./system-shell-tool.js";
import { clampModelThinkingLevel } from "./pi-runtime.js";
import { clampModelSpeed, createModelSpeedController } from "./model-speed.js";
import { arisaHomeDir, getChatPiSessionsDir } from "../../runtime/paths.js";
import { searchOfficialToolCatalog } from "../tools/official-tool-catalog.js";
import { ToolResourceNoteStore } from "../tools/tool-resource-note-store.js";

const piValidationTimeoutMs = 60_000;
const arisaToolNames = [
  "list_tools",
  "tool_help",
  "tool_skills",
  "set_tool_config",
  "set_tool_resource_note",
  "run_tool",
  "list_scheduled_tasks",
  "cancel_scheduled_task",
  "cancel_all_scheduled_tasks",
  "send_artifact"
];

function messageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n");
}

export function formatPortableSessionHistory(messages = []) {
  return messages
    .map((message) => {
      const text = messageText(message?.content);
      if (!text) return "";
      const role = message.role === "assistant"
        ? "Assistant"
        : message.role === "user"
          ? "User"
          : (message.customType ? `Session memory (${message.customType})` : "Session context");
      return `${role}:\n${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

const estimatedImageTokens = 1_200;

function estimateContentTokens(content) {
  if (typeof content === "string") return Math.ceil(content.length / 4);
  if (!Array.isArray(content)) return 0;
  const chars = content.reduce((total, item) => {
    if (item?.type === "image") return total + estimatedImageTokens * 4;
    if (typeof item?.text === "string") return total + item.text.length;
    if (typeof item?.thinking === "string") return total + item.thinking.length;
    if (item?.type === "toolCall") {
      return total + String(item.name || "").length + JSON.stringify(item.arguments || {}).length;
    }
    return total;
  }, 0);
  return Math.ceil(chars / 4);
}

function estimateMessageTokens(message) {
  if (["user", "assistant", "custom", "toolResult"].includes(message?.role)) {
    return estimateContentTokens(message.content);
  }
  if (message?.role === "bashExecution") {
    return Math.ceil((String(message.command || "").length + String(message.output || "").length) / 4);
  }
  if (["branchSummary", "compactionSummary"].includes(message?.role)) {
    return Math.ceil(String(message.summary || "").length / 4);
  }
  return 0;
}

function summarizeRetainedContext(messages = []) {
  const sizes = messages.map((message) => ({
    role: message?.role,
    tokens: estimateMessageTokens(message)
  }));
  const estimatedTokens = sizes.reduce((total, item) => total + item.tokens, 0);
  const toolResultTokens = sizes
    .filter((item) => item.role === "toolResult")
    .reduce((total, item) => total + item.tokens, 0);
  const largestMessageTokens = sizes.reduce((largest, item) => Math.max(largest, item.tokens), 0);
  return {
    messages: messages.length,
    estimatedTokens,
    toolResultPercent: estimatedTokens ? toolResultTokens / estimatedTokens * 100 : 0,
    largestMessagePercent: estimatedTokens ? largestMessageTokens / estimatedTokens * 100 : 0
  };
}

function closeAgentSession(session) {
  if (session?.close) return session.close();
  if (session?.dispose) return session.dispose();
  return undefined;
}

export const defaultScheduledTaskListLimit = 50;
export const maxScheduledTaskListLimit = 100;

export function selectScheduledTasks(tasks = [], { status, limit = defaultScheduledTaskListLimit } = {}) {
  const parsedLimit = Number(limit);
  const resolvedLimit = Math.min(
    Math.max(Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : defaultScheduledTaskListLimit, 1),
    maxScheduledTaskListLimit
  );
  const allTasks = Array.isArray(tasks) ? tasks : [];
  const orderedTasks = status
    ? [...allTasks].reverse()
    : [
        ...allTasks.filter((task) => task.status === "pending" || task.status === "running").reverse(),
        ...allTasks.filter((task) => task.status !== "pending" && task.status !== "running").reverse()
      ];
  const visibleTasks = orderedTasks.slice(0, resolvedLimit);

  return {
    tasks: visibleTasks,
    total: allTasks.length,
    returned: visibleTasks.length,
    limit: resolvedLimit,
    truncated: visibleTasks.length < allTasks.length
  };
}

function isLocalBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

function requiresProviderAuth(model) {
  return !isLocalBaseUrl(model?.baseUrl);
}

async function promptAndThrowOnAssistantError(session, prompt) {
  let assistantErrorMessage = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_end" && event.message?.stopReason === "error") {
      assistantErrorMessage = event.message.errorMessage || "assistant message ended with error";
    }
  });

  try {
    await session.prompt(prompt);
  } finally {
    unsubscribe();
  }

  if (assistantErrorMessage) {
    throw new Error(assistantErrorMessage);
  }
}

function inferDeliveryMethod(artifact) {
  if (artifact.kind === "audio" || (artifact.mimeType || "").startsWith("audio/")) return "audio";
  if (artifact.kind === "image" || (artifact.mimeType || "").startsWith("image/")) return "photo";
  if (artifact.kind === "video" || (artifact.mimeType || "").startsWith("video/")) return "video";
  return "document";
}

function containsAbsolutePath(value) {
  if (typeof value !== "string") return false;
  return /(^|\s)(\/[^\s]|[A-Za-z]:[\\/])/.test(value);
}

export function resolveMediaCaption(caption) {
  if (caption && !containsAbsolutePath(caption)) return caption;
  return undefined;
}

async function deliverArtifactToChat({ artifact, telegram, caption, method, logger }) {
  const resolvedMethod = method || artifact.metadata?.delivery?.method || inferDeliveryMethod(artifact);
  const fileName = path.basename(artifact.path);
  const resolvedCaption = resolveMediaCaption(caption);
  logger?.log("agent", `deliver artifact ${artifact.id} as ${resolvedMethod}`);
  await telegram.sendMedia(artifact.path, { method: resolvedMethod, caption: resolvedCaption, filename: fileName });
  return { method: resolvedMethod, fileName, artifactId: artifact.id };
}

async function assertDirectory(dir, label) {
  const stats = await stat(dir);
  if (!stats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${dir}`);
  }
}

export function createPiSettingsManager(config) {
  return SettingsManager.inMemory({ compaction: { ...config.pi.compaction } });
}

async function createArisaResourceLoader({ cwd, agentDir, settingsManager }) {
  const arisaAgentsContent = await readFile(arisaAgentsFile, "utf8");
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    agentsFilesOverride: (current) => appendArisaAgentsFile(current, arisaAgentsContent)
  });
  await resourceLoader.reload();
  return resourceLoader;
}

export class AgentManager {
  constructor({ config, artifactStore, toolRegistry, taskStore, logger }) {
    this.config = config;
    this.artifactStore = artifactStore;
    this.toolRegistry = toolRegistry;
    this.taskStore = taskStore;
    this.logger = logger;
    this.resourceNotes = new ToolResourceNoteStore();
    this.sessions = new Map();
    this.pendingNewSessions = new Set();
    this.pendingSessionHandoffs = new Map();
    this.artifactDeliveryHandler = null;
    this.sessionClosePromises = new Map();
  }

  setArtifactDeliveryHandler(handler) {
    this.artifactDeliveryHandler = handler;
  }

  async deliverArtifact(payload) {
    if (!this.artifactDeliveryHandler) throw new Error("Telegram artifact delivery is unavailable");
    return this.artifactDeliveryHandler(payload);
  }

  closeCachedSession(sessionKey) {
    const key = String(sessionKey);
    const existing = this.sessions.get(key);
    this.sessions.delete(key);
    const closeSession = (existing?.session?.close || existing?.session?.dispose)
      ? () => closeAgentSession(existing.session)
      : null;
    if (!closeSession) {
      return this.sessionClosePromises.get(key) || Promise.resolve();
    }

    const previousClose = this.sessionClosePromises.get(key);
    const closePromise = Promise.resolve(previousClose)
      .catch(() => {})
      .then(closeSession)
      .catch((error) => {
        this.logger?.error?.("agent", `session close failed for chat ${key}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.sessionClosePromises.get(key) === closePromise) {
          this.sessionClosePromises.delete(key);
        }
      });
    this.sessionClosePromises.set(key, closePromise);
    return closePromise;
  }

  async waitForSessionClose(sessionKey) {
    const key = String(sessionKey);
    let closing = this.sessionClosePromises.get(key);
    while (closing) {
      await closing;
      closing = this.sessionClosePromises.get(key);
    }
  }

  setConfig(config) {
    for (const key of this.sessions.keys()) this.closeCachedSession(key);
    this.config = config;
    this.pendingNewSessions.clear();
    this.pendingSessionHandoffs.clear();
  }

  resetSession(chatId, { handoff = "", parentSession = "" } = {}) {
    const sessionKey = String(chatId);
    this.closeCachedSession(sessionKey);
    this.pendingNewSessions.add(sessionKey);
    const text = String(handoff || "").trim();
    const parent = String(parentSession || "").trim();
    if (text || parent) {
      this.pendingSessionHandoffs.set(sessionKey, { text, parentSession: parent });
    } else {
      this.pendingSessionHandoffs.delete(sessionKey);
    }
  }

  clearSessionCache(chatId) {
    this.closeCachedSession(String(chatId));
  }

  async getRuntimeDiagnostic({ contextInspectionTimeoutMs } = {}) {
    const contexts = await Promise.all([...this.sessions.entries()].map(async ([chatId, context]) => {
      const base = { chatId };
      try {
        const stats = context.session.getSessionStats();
        const retained = summarizeRetainedContext(context.session.messages);
        return {
          ...base,
          ...retained,
          tokens: stats.contextUsage?.tokens ?? null,
          contextWindow: stats.contextUsage?.contextWindow ?? null,
          percent: stats.contextUsage?.percent ?? null
        };
      } catch (error) {
        return { ...base, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    return {
      harness: "pi",
      sessions: this.sessions.size,
      closingSessions: this.sessionClosePromises.size,
      managedProcessIds: [],
      contexts
    };
  }

  createSessionManager(chatId, workspaceDir = arisaInstallDir, sessionRevision = 0) {
    const sessionKey = String(chatId);
    const sessionDir = getChatPiSessionsDir(sessionKey, sessionRevision);
    if (this.pendingNewSessions.has(sessionKey)) {
      this.logger?.log("agent", `starting new persisted session for chat ${sessionKey}`);
      const handoff = this.pendingSessionHandoffs.get(sessionKey);
      const sessionManager = SessionManager.create(
        workspaceDir,
        sessionDir,
        handoff?.parentSession ? { parentSession: handoff.parentSession } : undefined
      );
      if (handoff?.text) {
        sessionManager.appendCustomMessageEntry(
          "arisa-session-handoff",
          handoff.text,
          false,
          { source: "telegram-new" }
        );
      }
      return { sessionManager, isNewSession: true };
    }
    this.logger?.log("agent", `recovering persisted session for chat ${sessionKey}`);
    return { sessionManager: SessionManager.continueRecent(workspaceDir, sessionDir), isNewSession: false };
  }

  async validatePiAgent(config = this.config) {
    this.logger?.log("agent", "validating Pi session");
    const { authStorage, modelRegistry } = createPiRuntime({
      provider: config.pi.provider,
      apiKey: config.pi.apiKey
    });
    const model = modelRegistry.find(config.pi.provider, config.pi.model);
    if (!model) {
      throw new Error(`Model not found: ${config.pi.provider}/${config.pi.model}`);
    }
    if (requiresProviderAuth(model) && !config.pi.apiKey && !hasProviderAuth(config.pi.provider, { authStorage, modelRegistry })) {
      throw new Error(`No auth found for ${config.pi.provider}. Provide a Pi API key in bootstrap, or authenticate with Pi login for this provider during bootstrap.`);
    }

    const settingsManager = createPiSettingsManager(config);
    const { session } = await createAgentSession({
      authStorage,
      modelRegistry,
      model,
      settingsManager,
      sessionManager: SessionManager.inMemory()
    });
    try {
      await withTimeout(promptAndThrowOnAssistantError(session, "Reply with exactly: OK"), {
        timeoutMs: piValidationTimeoutMs,
        label: "Pi validation prompt"
      });
    } finally {
      session.dispose();
    }
  }

  async validateAgent(config = this.config) {
    return this.validatePiAgent(config);
  }

  async getSessionContext(chatId, telegram) {
    const sessionKey = String(chatId);
    const modelSelection = resolveChatModelSelection(this.config, sessionKey);
    const effectiveModelId = modelSelection.model;
    const effectiveModelKey = `${modelSelection.provider}/${effectiveModelId}@${modelSelection.sessionRevision}`;
    if (this.sessions.has(sessionKey)) {
      const existing = this.sessions.get(sessionKey);
      if (existing?.modelKey === effectiveModelKey) {
        const desiredThinkingLevel = clampModelThinkingLevel(existing.session.model, modelSelection.thinkingLevel);
        if (existing.session.thinkingLevel !== desiredThinkingLevel) {
          this.logger?.log("agent", `updating effort for chat ${sessionKey}: ${existing.session.thinkingLevel} -> ${desiredThinkingLevel}`);
          existing.session.setThinkingLevel(desiredThinkingLevel);
        }
        const desiredSpeed = clampModelSpeed(existing.session.model, modelSelection.speed);
        if (existing.speedController.speed !== desiredSpeed) {
          this.logger?.log("agent", `updating speed for chat ${sessionKey}: ${existing.speedController.speed}x -> ${desiredSpeed}x`);
          existing.speedController.setSpeed(desiredSpeed);
        }
        this.logger?.log("agent", `reusing session for chat ${sessionKey}`);
        return existing;
      }
      this.logger?.log("agent", `model changed for chat ${sessionKey}: ${existing?.modelKey || "unknown"} -> ${effectiveModelKey}; recreating session`);
      this.closeCachedSession(sessionKey);
      this.pendingNewSessions.add(sessionKey);
    }

    const { authStorage, modelRegistry } = createPiRuntime({
      provider: this.config.pi.provider,
      apiKey: this.config.pi.apiKey
    });
    const model = modelRegistry.find(this.config.pi.provider, effectiveModelId);
    if (!model) throw new Error(`Model not found: ${this.config.pi.provider}/${effectiveModelId}`);
    if (requiresProviderAuth(model) && !this.config.pi.apiKey && !hasProviderAuth(this.config.pi.provider, { authStorage, modelRegistry })) {
      throw new Error(`No auth found for ${this.config.pi.provider}. Re-run bootstrap and complete login for this provider before Telegram starts.`);
    }
    const thinkingLevel = clampModelThinkingLevel(model, modelSelection.thinkingLevel);
    const speed = clampModelSpeed(model, modelSelection.speed);

    const policy = buildPiToolPolicy({
      config: this.config,
      customToolNames: [...arisaToolNames, "system_shell"]
    });
    await assertDirectory(policy.workspaceDir, "pi.workspaceDir");
    const { sessionManager, isNewSession } = this.createSessionManager(
      sessionKey,
      policy.workspaceDir,
      modelSelection.sessionRevision
    );
    const hasExistingSession = sessionManager.buildSessionContext().messages.length > 0;
    this.logger?.log("agent", `${hasExistingSession ? "resuming" : "creating"} session for chat ${sessionKey} with model ${effectiveModelId} effort ${thinkingLevel} speed ${speed}x`);
    const customTools = [
      ...this.createTools(telegram, chatId, policy),
      createSystemShellTool({ workspaceDir: policy.workspaceDir, shell: policy.shell })
    ];
    const settingsManager = createPiSettingsManager(this.config);
    const resourceLoader = await createArisaResourceLoader({
      cwd: policy.workspaceDir,
      agentDir: arisaHomeDir,
      settingsManager
    });
    const { session } = await createAgentSession({
      cwd: policy.workspaceDir,
      agentDir: arisaHomeDir,
      resourceLoader,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel,
      tools: policy.tools,
      excludeTools: policy.excludeTools,
      customTools,
      settingsManager,
      sessionManager
    });
    const speedController = createModelSpeedController(session.agent.streamFn, speed);
    session.agent.streamFn = speedController.streamFn;

    if (!hasExistingSession) {
      this.logger?.log("agent", `created new session for chat ${sessionKey}`);
      this.logger?.log("agent", `runtime context for chat ${sessionKey}:\n${buildAgentRuntimeContext({
        workspaceDir: policy.workspaceDir,
        coreTools: policy.coreTools
      })}`);
    }

    const ctx = { session, modelId: effectiveModelId, modelKey: effectiveModelKey, speedController };
    this.sessions.set(sessionKey, ctx);
    if (isNewSession) {
      this.pendingNewSessions.delete(sessionKey);
      this.pendingSessionHandoffs.delete(sessionKey);
    }
    return ctx;
  }

  async getAvailableModels(chatId) {
    const { listProviderModels } = await import("./pi-runtime.js");
    const runtime = createPiRuntime({ provider: this.config.pi.provider, apiKey: this.config.pi.apiKey });
    return listProviderModels(this.config.pi.provider, runtime);
  }

  async setModelSpeed(chatId, speed) {
    const context = this.sessions.get(String(chatId));
    if (!context) return speed;
    const effectiveSpeed = clampModelSpeed(context.session.model, speed);
    context.speedController.setSpeed(effectiveSpeed);
    return effectiveSpeed;
  }

  async close() {
    const contexts = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled([
      ...this.sessionClosePromises.values(),
      ...contexts.map((context) => closeAgentSession(context.session))
    ]);
  }

  async runTool({ name, request, chatId }) {
    await this.toolRegistry.load();
    this.logger?.log("agent", `run_tool ${name}`);
    const chatArtifactStore = this.artifactStore.forChat(chatId);
    const resourceId = String(request?.resourceId || "").trim();
    const resourceNote = resourceId
      ? await this.resourceNotes.get(chatId, name, resourceId)
      : "";
    const enrichedRequest = resourceNote ? { ...request, resourceId, resourceNote } : request;
    const result = await this.toolRegistry.run({ name, request: enrichedRequest, chatId });

    if (result.output?.text) {
      const outArtifact = await chatArtifactStore.createText({
        text: result.output.text,
        source: { type: "tool", toolName: name },
        metadata: { tool: name }
      });
      result.output.artifactId = outArtifact.id;
    }

    if (result.output?.filePath) {
      const generated = await chatArtifactStore.createFromFile({
        originalPath: result.output.filePath,
        fileName: result.output.fileName || path.basename(result.output.filePath),
        kind: result.output.kind || "file",
        mimeType: result.output.mimeType || "application/octet-stream",
        source: { type: "tool", toolName: name },
        metadata: { tool: name, delivery: result.output.delivery }
      });
      result.output.artifactId = generated.id;
      await unlink(result.output.filePath).catch(() => {});
    }

    if (result.asyncTask || result.asyncTasks?.length) {
      const scheduled = await this.taskStore.addMany(
        result.asyncTasks || [result.asyncTask],
        {
          payload: { chatId },
          source: { type: "tool", toolName: name, chatId }
        }
      );
      result.asyncTasks = scheduled;
      delete result.asyncTask;
    }

    return result;
  }

  createTools(telegram, chatId, policy = buildPiToolPolicy({ config: this.config, customToolNames: arisaToolNames })) {
    const chatArtifactStore = this.artifactStore.forChat(chatId);

    return [
      defineTool({
        name: "list_tools",
        label: "List tools",
        description: "List Arisa tools, or search installed tool metadata by capability with automatic official-catalog fallback.",
        parameters: Type.Object({ query: Type.Optional(Type.String()) }),
        execute: async (_id, params) => {
          await this.toolRegistry.load();
          const coreTools = getCoreCodingTools({
            tools: policy.tools,
            excludeTools: policy.excludeTools
          });
          const nativeTools = [{
            name: "system_shell",
            source: "arisa-native",
            description: "Run native system shell commands in the active Arisa workspace.",
            workspaceDir: policy.workspaceDir,
            shell: policy.shell.shellPath || (process.platform === "win32" ? "powershell" : "sh"),
            enabled: !(policy.excludeTools || []).includes("system_shell")
          }];
          const query = params.query?.trim() || "";
          let catalogFallback = null;
          const cliTools = query
            ? this.toolRegistry.search(query).map((tool) => ({
              ...tool,
              source: "arisa-modular",
              invocation: "run_tool"
            }))
            : (await this.toolRegistry.listWithRuntime(chatId)).map((tool) => ({
              ...tool,
              source: "arisa-modular",
              invocation: "run_tool"
            }));
          if (query && cliTools.length === 0) {
            try {
              catalogFallback = await searchOfficialToolCatalog(query);
            } catch (error) {
              catalogFallback = { unavailable: true, error: error?.message || String(error), matches: [] };
            }
          }
          const result = {
            query: query || null,
            workspaceDir: policy.workspaceDir,
            coreTools: query ? [] : coreTools,
            nativeTools: query ? [] : nativeTools,
            cliTools,
            officialCatalogMatches: Array.isArray(catalogFallback) ? catalogFallback : catalogFallback?.matches || [],
            catalogFallback: catalogFallback && !Array.isArray(catalogFallback) ? catalogFallback : null,
            tools: query ? cliTools : [...coreTools.filter((tool) => tool.enabled), ...nativeTools.filter((tool) => tool.enabled), ...cliTools]
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result
          };
        }
      }),
      defineTool({
        name: "tool_help",
        label: "Tool help",
        description: "Show --help text for a CLI tool.",
        parameters: Type.Object({ name: Type.String() }),
        execute: async (_id, params) => {
          await this.toolRegistry.load();
          const help = await this.toolRegistry.help(params.name);
          return { content: [{ type: "text", text: help }], details: { help } };
        }
      }),
      defineTool({
        name: "tool_skills",
        label: "Tool skills",
        description: "Show skills assigned to a CLI tool via its manifest skillHints.",
        parameters: Type.Object({ name: Type.String() }),
        execute: async (_id, params) => {
          await this.toolRegistry.load();
          const skills = await this.toolRegistry.resolveSkills(params.name);
          const visible = skills.map(({ content, ...item }) => item);
          return { content: [{ type: "text", text: JSON.stringify(visible, null, 2) }], details: visible };
        }
      }),
      defineTool({
        name: "set_tool_config",
        label: "Set tool config",
        description: "Write a tool config value scoped to the current chat.",
        parameters: Type.Object({ name: Type.String(), field: Type.String(), value: Type.String() }),
        execute: async (_id, params) => {
          await this.toolRegistry.load();
          const result = await this.toolRegistry.setConfig(params.name, params.field, params.value, chatId);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        }
      }),
      defineTool({
        name: "set_tool_resource_note",
        label: "Set tool resource note",
        description: "Set or clear a deterministic chat-scoped note of up to 200 characters for one tool resource.",
        parameters: Type.Object({
          name: Type.String(),
          resourceId: Type.String(),
          note: Type.String()
        }),
        execute: async (_id, params) => {
          const result = await this.resourceNotes.set(chatId, params.name, params.resourceId, params.note);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        }
      }),
      defineTool({
        name: "run_tool",
        label: "Run tool",
        description: "Run a CLI tool using text input or an artifactId. Inspect the returned status/resolution fields. If a tool reports missing config, ask the user naturally, use set_tool_config, and retry. Set `deliver: true` to also send the generated file to the chat in one step (only when you want the user to receive it now, not for intermediate pipe steps).",
        parameters: Type.Object({
          name: Type.String(),
          artifactId: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
          resourceId: Type.Optional(Type.String()),
          args: Type.Optional(Type.Record(Type.String(), Type.String())),
          deliver: Type.Optional(Type.Boolean())
        }),
        execute: async (_id, params) => {
          let artifact = null;
          if (params.artifactId) {
            artifact = await chatArtifactStore.get(params.artifactId);
            if (!artifact) {
              return { content: [{ type: "text", text: `Artifact not found: ${params.artifactId}` }], details: { ok: false } };
            }
          }
          const result = await this.runTool({
            name: params.name,
            request: {
              artifact,
              text: params.text,
              resourceId: params.resourceId,
              args: params.args || {}
            },
            chatId
          });

          if (params.deliver && result.output?.artifactId) {
            const generated = await chatArtifactStore.get(result.output.artifactId);
            if (generated?.path) {
              result.sent = await deliverArtifactToChat({ artifact: generated, telegram, logger: this.logger });
            }
          }

          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result
          };
        }
      }),
      defineTool({
        name: "list_scheduled_tasks",
        label: "List scheduled tasks",
        description: "List scheduled async tasks for the current Telegram chat. Results default to 50 tasks, always include pending/running tasks, and accept an optional limit up to 100.",
        parameters: Type.Object({
          status: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxScheduledTaskListLimit }))
        }),
        execute: async (_id, params) => {
          const tasks = await this.taskStore.list({ chatId, status: params.status });
          const result = selectScheduledTasks(tasks, {
            status: params.status,
            limit: params.limit
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result
          };
        }
      }),
      defineTool({
        name: "cancel_scheduled_task",
        label: "Cancel scheduled task",
        description: "Cancel one scheduled async task by id for the current Telegram chat.",
        parameters: Type.Object({ id: Type.String() }),
        execute: async (_id, params) => {
          const existing = await this.taskStore.get(params.id);
          if (!existing || existing.payload?.chatId !== chatId) {
            return {
              content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Task not found" }) }],
              details: { ok: false, error: "Task not found" }
            };
          }
          const task = await this.taskStore.cancel(params.id);
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, task }, null, 2) }],
            details: { ok: true, task }
          };
        }
      }),
      defineTool({
        name: "cancel_all_scheduled_tasks",
        label: "Cancel all scheduled tasks",
        description: "Cancel all pending or running async tasks for the current Telegram chat.",
        parameters: Type.Object({}),
        execute: async () => {
          const tasks = await this.taskStore.cancelAll({ chatId });
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, cancelled: tasks.length }, null, 2) }],
            details: { ok: true, tasks }
          };
        }
      }),
      defineTool({
        name: "send_artifact",
        label: "Send artifact",
        description: "Deliver an existing chat artifact to the current Telegram chat. Pass the `artifactId` returned by run_tool or from an inbound file. The delivery method and filename are derived from the artifact (its delivery hint, kind, and stored name); internal local paths are never exposed. No caption is shown by default, since the filename already appears on the attachment; set `caption` only to add a separate visible label, or `method` to override the delivery method. The artifact is not deleted.",
        parameters: Type.Object({
          artifactId: Type.String(),
          caption: Type.Optional(Type.String()),
          method: Type.Optional(Type.Union([
            Type.Literal("voice"),
            Type.Literal("audio"),
            Type.Literal("document")
          ]))
        }),
        execute: async (_id, params) => {
          const artifact = await chatArtifactStore.get(params.artifactId);
          if (!artifact) {
            const result = { ok: false, status: "failed", error: `Artifact not found: ${params.artifactId}` };
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
          }
          if (!artifact.path) {
            const result = { ok: false, status: "failed", error: `Artifact ${params.artifactId} has no file to deliver.` };
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
          }
          const sent = await deliverArtifactToChat({
            artifact,
            telegram,
            caption: params.caption,
            method: params.method,
            logger: this.logger
          });
          return {
            content: [{ type: "text", text: `Media sent to Telegram as ${sent.method}.` }],
            details: { ok: true, sent }
          };
        }
      })
    ];
  }
}
