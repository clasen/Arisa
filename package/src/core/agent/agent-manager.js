import path from "node:path";
import crypto from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createAgentSession, DefaultResourceLoader, SessionManager, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createPiRuntime, hasProviderAuth } from "./pi-runtime.js";
import { resolveChatModelSelection } from "./model-selection.js";
import { appendArisaAgentsFile, arisaAgentsFile, arisaInstallDir, buildAgentRuntimeContext } from "./runtime-context.js";
import { withTimeout } from "./prompt-timeout.js";
import { buildPiToolPolicy, getCoreCodingTools } from "./core-tools.js";
import { createSystemShellTool } from "./system-shell-tool.js";
import { clampModelThinkingLevel } from "./pi-runtime.js";
import { PrimeRpcSession, PrimeRpcSessionClosedError } from "./prime-rpc-session.js";
import { syncPrimeAuth } from "./prime-auth.js";
import {
  arisaHomeDir,
  arisaIpcSocketFile,
  arisaPackageDir,
  getChatPiSessionsDir,
  getChatPrimeHandoffFile,
  getChatPrimeSessionsDir,
  primeStateDir
} from "../../runtime/paths.js";

const piValidationTimeoutMs = 60_000;
const arisaToolNames = [
  "list_tools",
  "tool_help",
  "tool_skills",
  "set_tool_config",
  "run_tool",
  "list_scheduled_tasks",
  "cancel_scheduled_task",
  "cancel_all_scheduled_tasks",
  "send_artifact"
];

const legacyHandoffPrompt = [
  "Prepare a concise handoff for the next Arisa session.",
  "Review the entire active session, including compaction summaries and the latest messages.",
  "Keep only durable context: goals, decisions, preferences, unresolved tasks, and important continuation facts.",
  "Use at most 8 short bullets and at most 1600 characters.",
  "Exclude secrets, tokens, passwords, cookies, API keys, private file paths, transcripts, and stale chatter.",
  "Do not take actions, call tools, send messages, or explain the process.",
  "Return only the handoff."
].join("\n");

function sanitizeHandoff(text) {
  const sanitized = String(text || "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[redacted private key]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+)\b/gi, "[redacted credential]")
    .replace(/(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|cookie|secret)\s*[:=]\s*[^\s,;]+/gi, "[redacted credential]")
    .trim();
  return sanitized.length <= 4000 ? sanitized : `${sanitized.slice(0, 3997).trim()}...`;
}

async function containsJsonl(dir) {
  try {
    return (await readdir(dir)).some((name) => name.endsWith(".jsonl"));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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

async function createArisaResourceLoader({ cwd, agentDir }) {
  const arisaAgentsContent = await readFile(arisaAgentsFile, "utf8");
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
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
    this.sessions = new Map();
    this.pendingNewSessions = new Set();
    this.pendingSessionHandoffs = new Map();
    this.primeUiHandler = null;
    this.primeOutputHandler = null;
    this.artifactDeliveryHandler = null;
    this.idleTimers = new Map();
    this.primeCapabilities = new Map();
    this.pendingPrimeSessions = new Map();
    this.sessionClosePromises = new Map();
    this.primeSessionGenerations = new Map();
  }

  isPrimeRuntime() {
    return this.config.agent?.runtime === "prime";
  }

  setPrimeUiHandler(handler) {
    this.primeUiHandler = handler;
  }

  setPrimeOutputHandler(handler) {
    this.primeOutputHandler = handler;
  }

  setArtifactDeliveryHandler(handler) {
    this.artifactDeliveryHandler = handler;
  }

  async deliverArtifact(payload) {
    if (!this.artifactDeliveryHandler) throw new Error("Telegram artifact delivery is unavailable");
    return this.artifactDeliveryHandler(payload);
  }

  authorizePrimeCapability(chatId, capabilityToken) {
    if (chatId == null || !capabilityToken) return false;
    return this.primeCapabilities.get(String(chatId)) === capabilityToken;
  }

  closeCachedSession(sessionKey) {
    const key = String(sessionKey);
    const existing = this.sessions.get(key);
    this.sessions.delete(key);
    const timer = this.idleTimers.get(key);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(key);
    this.primeCapabilities.delete(key);
    existing?.unsubscribe?.();
    if (!existing?.session?.close) {
      return this.sessionClosePromises.get(key) || Promise.resolve();
    }

    const previousClose = this.sessionClosePromises.get(key);
    const closePromise = Promise.resolve(previousClose)
      .catch(() => {})
      .then(() => existing.session.close())
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

  trackPendingPrimeSession(sessionKey, modelKey, generation, promise) {
    const key = String(sessionKey);
    this.pendingPrimeSessions.set(key, { modelKey, generation, promise });
    void promise.finally(() => {
      if (this.pendingPrimeSessions.get(key)?.promise === promise) {
        this.pendingPrimeSessions.delete(key);
      }
    }).catch(() => {});
  }

  getPrimeSessionGeneration(sessionKey) {
    return this.primeSessionGenerations.get(String(sessionKey)) || 0;
  }

  invalidatePrimeSessionGeneration(sessionKey) {
    const key = String(sessionKey);
    this.primeSessionGenerations.set(key, this.getPrimeSessionGeneration(key) + 1);
  }

  async acceptPrimeSessionGeneration(sessionKey, generation, context) {
    const key = String(sessionKey);
    if (this.getPrimeSessionGeneration(key) === generation) return context;

    if (this.sessions.get(key) === context) this.sessions.delete(key);
    const idleTimer = this.idleTimers.get(key);
    if (idleTimer) clearTimeout(idleTimer);
    this.idleTimers.delete(key);
    this.primeCapabilities.delete(key);
    context?.unsubscribe?.();
    this.pendingNewSessions.add(key);
    await context?.session?.close?.();
    throw new PrimeRpcSessionClosedError("Prime RPC session reset during startup");
  }

  schedulePrimeIdleClose(sessionKey, session) {
    const key = String(sessionKey);
    const previous = this.idleTimers.get(key);
    if (previous) clearTimeout(previous);
    const idleMinutes = Number(this.config.prime?.idleMinutes || 90);
    const timer = setTimeout(() => {
      if (this.sessions.get(key)?.session !== session) return;
      this.logger?.log("agent", `closing idle Prime RPC session for chat ${key}`);
      this.closeCachedSession(key);
    }, Math.max(idleMinutes, 1) * 60_000);
    timer.unref?.();
    this.idleTimers.set(key, timer);
  }

  setConfig(config) {
    for (const key of this.sessions.keys()) this.closeCachedSession(key);
    this.config = config;
    this.pendingNewSessions.clear();
    this.pendingSessionHandoffs.clear();
  }

  resetSession(chatId, { handoff = "", parentSession = "" } = {}) {
    const sessionKey = String(chatId);
    this.invalidatePrimeSessionGeneration(sessionKey);
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

  async validatePiAgent() {
    this.logger?.log("agent", "validating Pi session");
    const { authStorage, modelRegistry } = createPiRuntime({
      provider: this.config.pi.provider,
      apiKey: this.config.pi.apiKey
    });
    const model = modelRegistry.find(this.config.pi.provider, this.config.pi.model);
    if (!model) {
      throw new Error(`Model not found: ${this.config.pi.provider}/${this.config.pi.model}`);
    }
    if (requiresProviderAuth(model) && !this.config.pi.apiKey && !hasProviderAuth(this.config.pi.provider, { authStorage, modelRegistry })) {
      throw new Error(`No auth found for ${this.config.pi.provider}. Provide a Pi API key in bootstrap, or authenticate with Pi login for this provider during bootstrap.`);
    }

    const { session } = await createAgentSession({
      authStorage,
      modelRegistry,
      model,
      sessionManager: SessionManager.inMemory(),
    });
    await withTimeout(promptAndThrowOnAssistantError(session, "Reply with exactly: OK"), {
      timeoutMs: piValidationTimeoutMs,
      label: "Pi validation prompt"
    });
  }

  async syncPrimeCredentials() {
    return syncPrimeAuth({
      provider: this.config.prime.provider,
      apiKey: this.config.prime.apiKey
    });
  }

  async validatePrimeAgent() {
    const prime = this.config.prime;
    await this.syncPrimeCredentials();
    const workspaceDir = path.resolve(prime.workspaceDir || arisaInstallDir);
    await assertDirectory(workspaceDir, "prime.workspaceDir");
    this.logger?.log("agent", `validating Prime Agent ${prime.version} with ${prime.provider}/${prime.model}`);
    const session = new PrimeRpcSession({
      command: prime.command,
      commandArgs: prime.commandArgs,
      expectedVersion: prime.version,
      provider: prime.provider,
      model: prime.model,
      thinkingLevel: prime.thinkingLevel,
      cwd: workspaceDir,
      agentDir: primeStateDir,
      sessionDir: primeStateDir,
      kernelVenvDir: prime.kernelVenvDir,
      chatId: "validation",
      noSession: true,
      logger: this.logger
    });
    try {
      await withTimeout(promptAndThrowOnAssistantError(session, "Reply with exactly: OK"), {
        timeoutMs: piValidationTimeoutMs,
        label: "Prime Agent validation prompt"
      });
    } finally {
      await session.close();
    }
  }

  async validateAgent() {
    return this.isPrimeRuntime() ? this.validatePrimeAgent() : this.validatePiAgent();
  }

  async summarizeLegacyPiSession(chatId, sessionRevision = 0) {
    const pi = this.config.pi;
    const selection = pi.chatModels?.[String(chatId)];
    const provider = selection?.provider === pi.provider ? selection.provider : pi.provider;
    const modelId = selection?.provider === pi.provider ? selection.model : pi.model;
    const workspaceDir = path.resolve(pi.workspaceDir || arisaInstallDir);
    const sessionDir = getChatPiSessionsDir(chatId, selection?.sessionRevision ?? sessionRevision);
    if (!await containsJsonl(sessionDir)) return "";
    const sessionManager = SessionManager.continueRecent(workspaceDir, sessionDir);
    if (!sessionManager.buildSessionContext().messages.length) return "";
    const { authStorage, modelRegistry } = createPiRuntime({ provider, apiKey: pi.apiKey });
    const model = modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Legacy Pi model not found: ${provider}/${modelId}`);
    const resourceLoader = await createArisaResourceLoader({ cwd: workspaceDir, agentDir: arisaHomeDir });
    const { session } = await createAgentSession({
      cwd: workspaceDir,
      agentDir: arisaHomeDir,
      resourceLoader,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: clampModelThinkingLevel(model, selection?.thinkingLevel || pi.thinkingLevel),
      tools: [],
      customTools: [],
      sessionManager
    });
    await promptAndThrowOnAssistantError(session, legacyHandoffPrompt);
    const message = [...session.messages].reverse().find((item) => item.role === "assistant");
    const text = Array.isArray(message?.content)
      ? message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n")
      : message?.content;
    return sanitizeHandoff(text);
  }

  async getPrimeSessionContext(chatId) {
    const sessionKey = String(chatId);
    const modelSelection = resolveChatModelSelection(this.config, sessionKey);
    const modelKey = `${modelSelection.provider}/${modelSelection.model}@${modelSelection.sessionRevision}`;
    const generation = this.getPrimeSessionGeneration(sessionKey);
    const pending = this.pendingPrimeSessions.get(sessionKey);
    if (pending?.modelKey === modelKey && pending.generation === generation) return pending.promise;
    if (pending) {
      await pending.promise.catch(() => {});
      return this.getPrimeSessionContext(sessionKey);
    }

    const creation = this.createPrimeSessionContext(sessionKey, modelSelection, modelKey)
      .then((context) => this.acceptPrimeSessionGeneration(sessionKey, generation, context));
    this.trackPendingPrimeSession(sessionKey, modelKey, generation, creation);
    return creation;
  }

  async createPrimeSessionContext(sessionKey, modelSelection, modelKey) {
    await this.waitForSessionClose(sessionKey);
    const existing = this.sessions.get(sessionKey);
    if (existing?.modelKey === modelKey) {
      if (existing.session.thinkingLevel !== modelSelection.thinkingLevel) {
        await existing.session.setThinkingLevel(modelSelection.thinkingLevel);
      }
      this.schedulePrimeIdleClose(sessionKey, existing.session);
      return existing;
    }
    if (existing) {
      this.logger?.log("agent", `Prime model changed for chat ${sessionKey}; recreating RPC session`);
      await this.closeCachedSession(sessionKey);
      this.pendingNewSessions.add(sessionKey);
    }

    const prime = this.config.prime;
    const workspaceDir = path.resolve(prime.workspaceDir || arisaInstallDir);
    await assertDirectory(workspaceDir, "prime.workspaceDir");
    await this.syncPrimeCredentials();
    const sessionDir = getChatPrimeSessionsDir(sessionKey, modelSelection.sessionRevision);
    const handoffFile = getChatPrimeHandoffFile(sessionKey, modelSelection.sessionRevision);
    const runtimeContextFile = path.join(sessionDir, "arisa-runtime-context.txt");
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    let pendingHandoff = this.pendingSessionHandoffs.get(sessionKey)?.text || "";
    if (!pendingHandoff && !this.pendingNewSessions.has(sessionKey) && !await containsJsonl(sessionDir)) {
      const piSelection = this.config.pi.chatModels?.[sessionKey];
      const legacyRevision = piSelection?.sessionRevision ?? modelSelection.sessionRevision;
      if (await containsJsonl(getChatPiSessionsDir(sessionKey, legacyRevision))) {
        let migrationStatus = "migrated";
        try {
          pendingHandoff = await this.summarizeLegacyPiSession(sessionKey, legacyRevision);
          if (!pendingHandoff) migrationStatus = "no_handoff";
          else this.logger?.log("agent", `created safe Pi-to-Prime handoff for chat ${sessionKey}`);
        } catch (error) {
          migrationStatus = "failed";
          this.logger?.error?.("agent", `Pi-to-Prime handoff failed for chat ${sessionKey}; starting Prime without imported context: ${error instanceof Error ? error.message : String(error)}`);
        }
        await writeFile(path.join(sessionDir, "migration.json"), `${JSON.stringify({
          from: "pi",
          to: "prime",
          status: migrationStatus,
          migratedAt: new Date().toISOString(),
          handoffCharacters: pendingHandoff.length,
          sourcePreserved: true
        }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      }
    }
    await writeFile(handoffFile, pendingHandoff, { encoding: "utf8", mode: 0o600 });
    await writeFile(runtimeContextFile, buildAgentRuntimeContext({
      workspaceDir,
      coreTools: [{ name: "ipython", enabled: true, source: "prime-native" }]
    }), { encoding: "utf8", mode: 0o600 });

    const session = new PrimeRpcSession({
      command: prime.command,
      commandArgs: prime.commandArgs,
      expectedVersion: prime.version,
      provider: modelSelection.provider,
      model: modelSelection.model,
      thinkingLevel: modelSelection.thinkingLevel,
      cwd: workspaceDir,
      agentDir: primeStateDir,
      sessionDir,
      kernelVenvDir: prime.kernelVenvDir,
      extensionPath: path.join(arisaPackageDir, "src", "core", "agent", "prime-arisa-extension.js"),
      chatId: sessionKey,
      continueSession: !this.pendingNewSessions.has(sessionKey),
      env: {
        ARISA_IPC_SOCKET: arisaIpcSocketFile,
        ARISA_PACKAGE_DIR: arisaPackageDir,
        ARISA_AGENTS_FILE: arisaAgentsFile,
        ARISA_RUNTIME_CONTEXT_FILE: runtimeContextFile,
        ARISA_HANDOFF_FILE: handoffFile
      },
      logger: this.logger,
      onUiRequest: (request) => this.primeUiHandler?.(sessionKey, request),
      onUnsolicitedText: (text, event) => this.primeOutputHandler?.(sessionKey, text, event)
    });
    const capabilityToken = crypto.randomBytes(32).toString("hex");
    session.extraEnv.ARISA_IPC_TOKEN = capabilityToken;
    this.primeCapabilities.set(sessionKey, capabilityToken);
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start") {
        const timer = this.idleTimers.get(sessionKey);
        if (timer) clearTimeout(timer);
        this.idleTimers.delete(sessionKey);
      } else if (event.type === "agent_end") {
        this.schedulePrimeIdleClose(sessionKey, session);
      }
    });
    try {
      await session.start();
    } catch (error) {
      this.primeCapabilities.delete(sessionKey);
      unsubscribe();
      await session.close().catch(() => {});
      throw error;
    }
    const ctx = { session, modelId: modelSelection.model, modelKey, unsubscribe };
    this.sessions.set(sessionKey, ctx);
    this.pendingNewSessions.delete(sessionKey);
    this.pendingSessionHandoffs.delete(sessionKey);
    this.schedulePrimeIdleClose(sessionKey, session);
    return ctx;
  }

  async getSessionContext(chatId, telegram) {
    if (this.isPrimeRuntime()) return this.getPrimeSessionContext(chatId);
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
    this.logger?.log("agent", `${hasExistingSession ? "resuming" : "creating"} session for chat ${sessionKey} with model ${effectiveModelId} effort ${thinkingLevel}`);
    const customTools = [
      ...this.createTools(telegram, chatId, policy),
      createSystemShellTool({ workspaceDir: policy.workspaceDir, shell: policy.shell })
    ];
    const resourceLoader = await createArisaResourceLoader({
      cwd: policy.workspaceDir,
      agentDir: arisaHomeDir
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
      sessionManager
    });

    if (!hasExistingSession) {
      this.logger?.log("agent", `created new session for chat ${sessionKey}`);
      this.logger?.log("agent", `runtime context for chat ${sessionKey}:\n${buildAgentRuntimeContext({
        workspaceDir: policy.workspaceDir,
        coreTools: policy.coreTools
      })}`);
    }

    const ctx = { session, modelId: effectiveModelId, modelKey: effectiveModelKey };
    this.sessions.set(sessionKey, ctx);
    if (isNewSession) {
      this.pendingNewSessions.delete(sessionKey);
      this.pendingSessionHandoffs.delete(sessionKey);
    }
    return ctx;
  }

  async getAvailableModels(chatId) {
    if (!this.isPrimeRuntime()) {
      const { listProviderModels } = await import("./pi-runtime.js");
      const runtime = createPiRuntime({ provider: this.config.pi.provider, apiKey: this.config.pi.apiKey });
      return listProviderModels(this.config.pi.provider, runtime);
    }
    const { session } = await this.getPrimeSessionContext(chatId);
    const models = await session.getAvailableModels();
    return models.filter((model) => !model.provider || model.provider === this.config.prime.provider);
  }

  async setPrimeModel(chatId, model) {
    if (!this.isPrimeRuntime()) return model;
    const { session } = await this.getPrimeSessionContext(chatId);
    return session.setModel(model.provider, model.id);
  }

  async setPrimeThinkingLevel(chatId, thinkingLevel) {
    if (!this.isPrimeRuntime()) return thinkingLevel;
    const { session } = await this.getPrimeSessionContext(chatId);
    await session.setThinkingLevel(thinkingLevel);
    return thinkingLevel;
  }

  async close() {
    const contexts = [...this.sessions.values()];
    const pendingSessions = [...this.pendingPrimeSessions.values()].map(({ promise }) => promise);
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.primeCapabilities.clear();
    this.sessions.clear();
    for (const context of contexts) context.unsubscribe?.();
    const createdContexts = (await Promise.allSettled(pendingSessions))
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value)
      .filter((context) => context && !contexts.includes(context));
    for (const context of createdContexts) context.unsubscribe?.();
    await Promise.allSettled([
      ...this.sessionClosePromises.values(),
      ...contexts.map((context) => context.session?.close?.()),
      ...createdContexts.map((context) => context.session?.close?.())
    ]);
  }

  async runTool({ name, request, chatId }) {
    await this.toolRegistry.load();
    this.logger?.log("agent", `run_tool ${name}`);
    const chatArtifactStore = this.artifactStore.forChat(chatId);
    const result = await this.toolRegistry.run({ name, request, chatId });

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
        description: "List Arisa core, native shell, and modular CLI tools with their capabilities.",
        parameters: Type.Object({}),
        execute: async () => {
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
          const cliTools = this.toolRegistry.list().map((tool) => ({
            ...tool,
            source: "arisa-modular",
            invocation: "run_tool"
          }));
          const result = {
            workspaceDir: policy.workspaceDir,
            coreTools,
            nativeTools,
            cliTools,
            tools: [...coreTools.filter((tool) => tool.enabled), ...nativeTools.filter((tool) => tool.enabled), ...cliTools]
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
        name: "run_tool",
        label: "Run tool",
        description: "Run a CLI tool using text input or an artifactId. Inspect the returned status/resolution fields. If a tool reports missing config, ask the user naturally, use set_tool_config, and retry. Set `deliver: true` to also send the generated file to the chat in one step (only when you want the user to receive it now, not for intermediate pipe steps).",
        parameters: Type.Object({
          name: Type.String(),
          artifactId: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
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
