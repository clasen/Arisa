import path from "node:path";
import { stat, unlink } from "node:fs/promises";
import { createAgentSession, SessionManager, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createPiRuntime, hasProviderAuth } from "./pi-runtime.js";
import { arisaInstallDir, buildAgentRuntimeContext } from "./runtime-context.js";
import { withTimeout } from "./prompt-timeout.js";
import { buildPiToolPolicy, getCoreCodingTools } from "./core-tools.js";
import { createSystemShellTool } from "./system-shell-tool.js";
import { arisaHomeDir, getChatPiSessionsDir } from "../../runtime/paths.js";

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
  return "document";
}

function containsAbsolutePath(value) {
  if (typeof value !== "string") return false;
  return /(^|\s)(\/[^\s]|[A-Za-z]:[\\/])/.test(value);
}

function resolveMediaCaption({ caption, output, method }) {
  if (caption && !containsAbsolutePath(caption)) return caption;
  if (method === "document" && output?.fileName) return output.fileName;
  if (output?.text && !containsAbsolutePath(output.text)) return output.text;
  if (output?.fileName) return output.fileName;
  return undefined;
}

async function deliverArtifactToChat({ artifact, telegram, caption, method, logger }) {
  const resolvedMethod = method || artifact.metadata?.delivery?.method || inferDeliveryMethod(artifact);
  const fileName = path.basename(artifact.path);
  const resolvedCaption = resolveMediaCaption({ caption, output: { fileName }, method: resolvedMethod });
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

export class AgentManager {
  constructor({ config, artifactStore, toolRegistry, taskStore, logger }) {
    this.config = config;
    this.artifactStore = artifactStore;
    this.toolRegistry = toolRegistry;
    this.taskStore = taskStore;
    this.logger = logger;
    this.sessions = new Map();
    this.pendingNewSessions = new Set();
  }

  setConfig(config) {
    this.config = config;
    this.sessions.clear();
    this.pendingNewSessions.clear();
  }

  resetSession(chatId) {
    const sessionKey = String(chatId);
    this.sessions.delete(sessionKey);
    this.pendingNewSessions.add(sessionKey);
  }

  clearSessionCache(chatId) {
    this.sessions.delete(String(chatId));
  }

  createSessionManager(chatId, workspaceDir = arisaInstallDir) {
    const sessionKey = String(chatId);
    const sessionDir = getChatPiSessionsDir(sessionKey);
    if (this.pendingNewSessions.has(sessionKey)) {
      this.logger?.log("agent", `starting new persisted session for chat ${sessionKey}`);
      return { sessionManager: SessionManager.create(workspaceDir, sessionDir), isNewSession: true };
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

  async getSessionContext(chatId, telegram) {
    const sessionKey = String(chatId);
    const effectiveModelId = this.config.pi.model;
    if (this.sessions.has(sessionKey)) {
      const existing = this.sessions.get(sessionKey);
      if (existing?.modelId === effectiveModelId) {
        this.logger?.log("agent", `reusing session for chat ${sessionKey}`);
        return existing;
      }
      this.logger?.log("agent", `model changed for chat ${sessionKey}: ${existing?.modelId || "unknown"} -> ${effectiveModelId}; recreating session`);
      this.sessions.delete(sessionKey);
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

    const policy = buildPiToolPolicy({
      config: this.config,
      customToolNames: [...arisaToolNames, "system_shell"]
    });
    await assertDirectory(policy.workspaceDir, "pi.workspaceDir");
    const { sessionManager, isNewSession } = this.createSessionManager(sessionKey, policy.workspaceDir);
    const hasExistingSession = sessionManager.buildSessionContext().messages.length > 0;
    this.logger?.log("agent", `${hasExistingSession ? "resuming" : "creating"} session for chat ${sessionKey} with model ${effectiveModelId}`);
    const customTools = [
      ...this.createTools(telegram, chatId, policy),
      createSystemShellTool({ workspaceDir: policy.workspaceDir, shell: policy.shell })
    ];
    const { session } = await createAgentSession({
      cwd: policy.workspaceDir,
      agentDir: arisaHomeDir,
      authStorage,
      modelRegistry,
      model,
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

    const ctx = { session, modelId: effectiveModelId };
    this.sessions.set(sessionKey, ctx);
    if (isNewSession) {
      this.pendingNewSessions.delete(sessionKey);
    }
    return ctx;
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
        description: "List scheduled async tasks for the current Telegram chat.",
        parameters: Type.Object({
          status: Type.Optional(Type.String())
        }),
        execute: async (_id, params) => {
          const tasks = await this.taskStore.list({ chatId, status: params.status });
          return {
            content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
            details: { tasks }
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
        description: "Deliver an existing chat artifact to the current Telegram chat. Pass the `artifactId` returned by run_tool or from an inbound file. The delivery method, caption, and filename are derived from the artifact (its delivery hint, kind, and stored name); internal local paths are never exposed. Set `caption` for a visible label, or `method` to override the delivery method. The artifact is not deleted.",
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
