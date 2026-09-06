import { readFile, stat } from "node:fs/promises";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createPiRuntime, hasProviderAuth } from "./pi-runtime.js";
import { resolveChatModelSelection } from "./model-selection.js";
import { appendArisaAgentsFile, arisaAgentsFile, arisaInstallDir, buildAgentRuntimeContext } from "./runtime-context.js";
import { withTimeout } from "./prompt-timeout.js";
import { buildPiToolPolicy } from "./core-tools.js";
import { createSystemShellTool } from "./system-shell-tool.js";
import { clampModelThinkingLevel } from "./pi-runtime.js";
import { clampModelSpeed, createModelSpeedController } from "./model-speed.js";
import { arisaHomeDir } from "../../platform/paths.js";
import { AgentSessionLifecycle } from "./agent-session-lifecycle.js";
import { createPiCapabilityTools } from "./pi-capability-tools.js";
import { ToolResourceNoteStore } from "../tools/tool-resource-note-store.js";
import { materializeToolOutput } from "../tools/tool-output-materializer.js";
import { WorkerHeapCircuitBreaker } from "./worker-heap-circuit-breaker.js";
import { WorkerToolFanoutController } from "./worker-tool-fanout.js";
import { compactionRotationRequest, normalizeSessionRotationPolicy } from "./session-rotation.js";
import { AgentTurnCoordinator } from "./agent-turn-coordinator.js";

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
  "create_telegram_topic",
  "initialize_telegram_topic",
  "send_artifact"
];

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

function guardTools(tools, accessGuard) {
  return tools.map((tool) => ({
    ...tool,
    execute: async (...args) => {
      await accessGuard();
      return tool.execute(...args);
    }
  }));
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
    this.sessionLifecycle = new AgentSessionLifecycle({
      logger,
      summarizeContext: summarizeRetainedContext,
      cachePolicy: config.pi.sessionCache,
      sessionRotationPolicy: config.pi.sessionRotation
    });
    this.heapCircuitBreaker = new WorkerHeapCircuitBreaker({
      lifecycle: this.sessionLifecycle,
      logger,
      config: config.pi.heapCircuitBreaker
    });
    this.toolFanout = new WorkerToolFanoutController({
      heapCircuitBreaker: this.heapCircuitBreaker,
      logger,
      config: config.pi.toolFanout
    });
    this.turnCoordinator = new AgentTurnCoordinator({
      logger,
      config: config.pi.turnCoordinator
    });
    this.sessions = this.sessionLifecycle.sessions;
    this.pendingNewSessions = this.sessionLifecycle.pendingNewSessions;
    this.pendingSessionHandoffs = this.sessionLifecycle.pendingSessionHandoffs;
    this.sessionClosePromises = this.sessionLifecycle.sessionClosePromises;
    this.artifactDeliveryHandler = null;
    this.capabilityService = null;
  }

  setCapabilityService(capabilityService) {
    if (!capabilityService?.execute) throw new Error("AgentManager requires CapabilityService");
    this.capabilityService = capabilityService;
  }

  setArtifactDeliveryHandler(handler) {
    this.artifactDeliveryHandler = handler;
  }

  async deliverArtifact(payload) {
    if (!this.artifactDeliveryHandler) throw new Error("Telegram artifact delivery is unavailable");
    return this.artifactDeliveryHandler(payload);
  }

  closeCachedSession(sessionKey) {
    return this.sessionLifecycle.closeCached(sessionKey);
  }

  waitForSessionClose(sessionKey) {
    return this.sessionLifecycle.waitForClose(sessionKey);
  }

  setConfig(config) {
    this.sessionLifecycle.resetConfigState();
    this.sessionLifecycle.setCachePolicy(config.pi.sessionCache);
    this.sessionLifecycle.setSessionRotationPolicy(config.pi.sessionRotation);
    this.heapCircuitBreaker.setConfig(config.pi.heapCircuitBreaker);
    this.toolFanout.setConfig(config.pi.toolFanout);
    this.turnCoordinator.setConfig(config.pi.turnCoordinator);
    this.config = config;
  }

  resetSession(chatId, options = {}) {
    this.sessionLifecycle.resetSession(chatId, options);
  }

  clearSessionCache(chatId) {
    this.sessionLifecycle.closeCached(String(chatId));
  }

  async abortSession(chatId) {
    const sessionKey = String(chatId);
    const context = this.sessions.get(sessionKey);
    try {
      await context?.session?.abort?.();
    } finally {
      await this.sessionLifecycle.closeCached(sessionKey);
    }
  }

  async getRuntimeDiagnostic() {
    const diagnostic = await this.sessionLifecycle.getDiagnostic();
    return {
      ...diagnostic,
      heapCircuitBreaker: this.heapCircuitBreaker.getDiagnostic(),
      toolFanout: this.toolFanout.getDiagnostic(),
      turnCoordinator: this.turnCoordinator.diagnostic()
    };
  }

  createSessionManager(chatId, workspaceDir = arisaInstallDir, sessionRevision = 0) {
    return this.sessionLifecycle.createSessionManager(chatId, workspaceDir, sessionRevision);
  }

  async estimatePersistedSessionBytes(session) {
    const sessionStats = session?.getSessionStats?.();
    const sessionFile = session?.sessionManager?.getSessionFile?.() || sessionStats?.sessionFile;
    if (!sessionFile) return 0;
    try {
      return (await stat(sessionFile)).size;
    } catch {
      return 0;
    }
  }

  async acquireSessionContext(sessionKey, context) {
    const persistedBytes = await this.estimatePersistedSessionBytes(context.session);
    this.sessionLifecycle.acquireCached(sessionKey, persistedBytes);
    context.release = () => this.releaseSessionContext(sessionKey, context);
    await this.sessionLifecycle.enforceCachePolicy({ protectedSessionKeys: [sessionKey] });
    return context;
  }

  async compactPersistedSessionIfNeeded(sessionKey, context, persistedBytes) {
    const policy = normalizeSessionRotationPolicy(this.config.pi.sessionRotation);
    if (!policy.enabled
      || persistedBytes <= policy.compactAtPersistedBytes
      || context.rotationRequest
      || typeof context.session?.compact !== "function") return;
    try {
      this.logger?.log("agent", `compacting ${Math.ceil(persistedBytes / 1024 / 1024)} MiB Pi session for chat ${sessionKey} before rotation`);
      await context.session.compact();
      await context.rotationCheckPromise;
    } catch (error) {
      this.logger?.error?.("agent", `persisted-size compaction failed for chat ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async releaseSessionContext(sessionKey, context) {
    if (this.sessions.get(String(sessionKey)) !== context) return;
    await context.rotationCheckPromise;
    const persistedBytes = await this.estimatePersistedSessionBytes(context.session);
    if ((context.activeUsers || 0) <= 1) {
      await this.compactPersistedSessionIfNeeded(sessionKey, context, persistedBytes);
    }
    this.sessionLifecycle.releaseCached(sessionKey, persistedBytes);
    if ((context.activeUsers || 0) === 0 && context.rotationRequest) {
      const request = context.rotationRequest;
      const parentSession = context.session.sessionFile || "";
      this.logger?.log("agent", `rotating ${Math.ceil(request.persistedBytes / 1024 / 1024)} MiB Pi session for chat ${sessionKey} after compaction`);
      this.sessionLifecycle.resetSession(sessionKey, {
        handoff: request.handoff,
        parentSession,
        source: "compaction-rotation"
      });
      await this.sessionLifecycle.waitForClose(sessionKey);
      return;
    }
    await this.sessionLifecycle.enforceCachePolicy();
  }

  scheduleCompactionRotationCheck(sessionKey, context, event) {
    if (event?.type !== "compaction_end") return;
    const previous = context.rotationCheckPromise || Promise.resolve();
    context.rotationCheckPromise = previous
      .catch(() => {})
      .then(async () => {
        if (this.sessions.get(String(sessionKey)) !== context) return;
        const persistedBytes = await this.estimatePersistedSessionBytes(context.session);
        const request = compactionRotationRequest(event, persistedBytes, this.config.pi.sessionRotation);
        if (request) context.rotationRequest = request;
      })
      .catch((error) => {
        this.logger?.error?.("agent", `session rotation check failed for chat ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  async validatePiAgent(config = this.config) {
    this.logger?.log("agent", "validating Pi session");
    const modelRuntime = await createPiRuntime({
      provider: config.pi.provider,
      apiKey: config.pi.apiKey
    });
    const model = modelRuntime.getModel(config.pi.provider, config.pi.model);
    if (!model) {
      throw new Error(`Model not found: ${config.pi.provider}/${config.pi.model}`);
    }
    if (requiresProviderAuth(model) && !config.pi.apiKey && !hasProviderAuth(config.pi.provider, modelRuntime)) {
      throw new Error(`No auth found for ${config.pi.provider}. Provide a Pi API key in bootstrap, or authenticate with Pi login for this provider during bootstrap.`);
    }

    const settingsManager = createPiSettingsManager(config);
    const { session } = await createAgentSession({
      modelRuntime,
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

  async getSessionContext(chatId, telegram, { scopeChatId = chatId, accessGuard = async () => {} } = {}) {
    await this.heapCircuitBreaker.admit();
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
        existing.telegramTarget.current = telegram;
        existing.accessGuardTarget.current = accessGuard;
        this.logger?.log("agent", `reusing session for chat ${sessionKey}`);
        return this.acquireSessionContext(sessionKey, existing);
      }
      this.logger?.log("agent", `model changed for chat ${sessionKey}: ${existing?.modelKey || "unknown"} -> ${effectiveModelKey}; recreating session`);
      this.closeCachedSession(sessionKey);
      this.pendingNewSessions.add(sessionKey);
    }

    const modelRuntime = await createPiRuntime({
      provider: this.config.pi.provider,
      apiKey: this.config.pi.apiKey
    });
    const model = modelRuntime.getModel(this.config.pi.provider, effectiveModelId);
    if (!model) throw new Error(`Model not found: ${this.config.pi.provider}/${effectiveModelId}`);
    if (requiresProviderAuth(model) && !this.config.pi.apiKey && !hasProviderAuth(this.config.pi.provider, modelRuntime)) {
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
    const telegramTarget = { current: telegram };
    const accessGuardTarget = { current: accessGuard };
    const telegramProxy = {
      sendMedia: (...args) => telegramTarget.current.sendMedia(...args),
      createForumTopic: (...args) => telegramTarget.current.createForumTopic(...args),
      initializeForumTopic: (...args) => telegramTarget.current.initializeForumTopic(...args),
      prepareRestartReceipt: (...args) => telegramTarget.current.prepareRestartReceipt(...args),
      cancelRestartReceipt: (...args) => telegramTarget.current.cancelRestartReceipt(...args),
      getTaskContext: (...args) => telegramTarget.current.getTaskContext?.(...args) || null,
      getAgentTaskExecution: (...args) => telegramTarget.current.getAgentTaskExecution?.(...args) || null
    };
    const assertAccess = () => accessGuardTarget.current();
    const customTools = guardTools([
      ...this.createTools(telegramProxy, scopeChatId, policy),
      createSystemShellTool({
        workspaceDir: policy.workspaceDir,
        shell: policy.shell,
        beforeRestart: (summary) => telegramProxy.prepareRestartReceipt(summary),
        cancelRestart: (receiptId) => telegramProxy.cancelRestartReceipt(receiptId)
      })
    ], assertAccess);
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
      modelRuntime,
      model,
      thinkingLevel,
      tools: policy.tools,
      excludeTools: policy.excludeTools,
      customTools,
      settingsManager,
      sessionManager
    });
    const speedController = createModelSpeedController(session.agent.streamFunction, speed);
    session.agent.streamFunction = speedController.streamFn;

    if (!hasExistingSession) {
      this.logger?.log("agent", `created new session for chat ${sessionKey}`);
      this.logger?.log("agent", `runtime context for chat ${sessionKey}:\n${buildAgentRuntimeContext({
        workspaceDir: policy.workspaceDir,
        coreTools: policy.coreTools
      })}`);
    }

    const ctx = {
      session,
      modelId: effectiveModelId,
      modelKey: effectiveModelKey,
      speedController,
      telegramTarget,
      accessGuardTarget,
      rotationCheckPromise: Promise.resolve(),
      rotationRequest: null
    };
    session.subscribe((event) => this.scheduleCompactionRotationCheck(sessionKey, ctx, event));
    this.sessions.set(sessionKey, ctx);
    if (isNewSession) this.sessionLifecycle.completeNewSession(sessionKey);
    return this.acquireSessionContext(sessionKey, ctx);
  }

  async getAvailableModels(chatId) {
    const { listProviderModels } = await import("./pi-runtime.js");
    const runtime = await createPiRuntime({ provider: this.config.pi.provider, apiKey: this.config.pi.apiKey });
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
    this.turnCoordinator.close();
    await this.sessionLifecycle.closeAll();
  }

  async runTurn(options, work) {
    if (typeof work !== "function") throw new Error("Agent turn work is required");
    return this.turnCoordinator.run(options, work);
  }

  async runTool({ name, request, chatId, taskContext = null }) {
    await this.toolRegistry.load();
    this.logger?.log("agent", `run_tool ${name}`);
    const resourceId = String(request?.resourceId || "").trim();
    const resourceNote = resourceId
      ? await this.resourceNotes.get(chatId, name, resourceId)
      : "";
    const enrichedRequest = resourceNote ? { ...request, resourceId, resourceNote } : request;
    const result = await this.toolRegistry.run({ name, request: enrichedRequest, chatId });

    return materializeToolOutput({
      result,
      name,
      chatId,
      artifactStore: this.artifactStore,
      taskStore: this.taskStore,
      taskContext
    });
  }

  createTools(telegram, chatId, policy = buildPiToolPolicy({ config: this.config, customToolNames: arisaToolNames })) {
    return createPiCapabilityTools({
      capabilityService: this.capabilityService,
      telegram,
      chatId,
      policy,
      logger: this.logger,
      toolFanout: this.toolFanout
    });
  }

}
