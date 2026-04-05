import path from "node:path";
import { mkdir, unlink } from "node:fs/promises";
import { createAgentSession, SessionManager, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createPiRuntime, hasProviderAuth } from "./pi-runtime.js";
import { getChatDir, piAgentDir as agentDir } from "../../runtime/paths.js";

export class AgentManager {
  constructor({ config, artifactStore, toolRegistry, logger }) {
    this.config = config;
    this.artifactStore = artifactStore;
    this.toolRegistry = toolRegistry;
    this.logger = logger;
    this.sessions = new Map();
  }

  setConfig(config) {
    this.config = config;
    this.sessions.clear();
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
    if (!this.config.pi.apiKey && !hasProviderAuth(this.config.pi.provider, { authStorage, modelRegistry })) {
      throw new Error(`No auth found for ${this.config.pi.provider}. Provide a Pi API key in bootstrap, or authenticate with Pi login for this provider during bootstrap.`);
    }

    const { session } = await createAgentSession({
      authStorage,
      modelRegistry,
      model,
      sessionManager: SessionManager.inMemory(),
    });
    await session.prompt("Reply with exactly: OK");
  }

  async getSessionContext(chatId, telegram) {
    if (this.sessions.has(chatId)) {
      this.logger?.log("agent", `reusing session for chat ${chatId}`);
      return this.sessions.get(chatId);
    }

    await mkdir(agentDir, { recursive: true });
    const { authStorage, modelRegistry } = createPiRuntime({
      provider: this.config.pi.provider,
      apiKey: this.config.pi.apiKey
    });
    const model = modelRegistry.find(this.config.pi.provider, this.config.pi.model);
    if (!model) throw new Error(`Model not found: ${this.config.pi.provider}/${this.config.pi.model}`);
    if (!this.config.pi.apiKey && !hasProviderAuth(this.config.pi.provider, { authStorage, modelRegistry })) {
      throw new Error(`No auth found for ${this.config.pi.provider}. Re-run bootstrap and complete login for this provider before Telegram starts.`);
    }

    const cwd = getChatDir(chatId);
    await mkdir(cwd, { recursive: true });

    this.logger?.log("agent", `creating session for chat ${chatId}`);
    const customTools = this.createTools(telegram);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      customTools,
      sessionManager: SessionManager.continueRecent(cwd)
    });

    const ctx = { session };
    this.sessions.set(chatId, ctx);
    return ctx;
  }

  createTools(telegram) {
    return [
      defineTool({
        name: "list_tools",
        label: "List tools",
        description: "List registered CLI tools and their capabilities.",
        parameters: Type.Object({}),
        execute: async () => {
          await this.toolRegistry.load();
          return {
            content: [{ type: "text", text: JSON.stringify(this.toolRegistry.list(), null, 2) }],
            details: { tools: this.toolRegistry.list() }
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
        name: "set_tool_config",
        label: "Set tool config",
        description: "Write a value into ~/.arisa/tools/<tool>/config.js.",
        parameters: Type.Object({ name: Type.String(), field: Type.String(), value: Type.String() }),
        execute: async (_id, params) => {
          await this.toolRegistry.load();
          const result = await this.toolRegistry.setConfig(params.name, params.field, params.value);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        }
      }),
      defineTool({
        name: "run_tool",
        label: "Run tool",
        description: "Run a CLI tool using text input or an artifactId. If config is missing, ask the user naturally and then use set_tool_config.",
        parameters: Type.Object({
          name: Type.String(),
          artifactId: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
          args: Type.Optional(Type.Record(Type.String(), Type.String()))
        }),
        execute: async (_id, params) => {
          await this.toolRegistry.load();
          this.logger?.log("agent", `run_tool ${params.name}`);
          let artifact = null;
          if (params.artifactId) {
            artifact = await this.artifactStore.get(params.artifactId);
            if (!artifact) {
              return { content: [{ type: "text", text: `Artifact not found: ${params.artifactId}` }], details: { ok: false } };
            }
          }
          const result = await this.toolRegistry.run({
            name: params.name,
            request: {
              artifact,
              text: params.text,
              args: params.args || {}
            }
          });

          if (result.output?.text) {
            const outArtifact = await this.artifactStore.createText({
              text: result.output.text,
              source: { type: "tool", toolName: params.name },
              metadata: { tool: params.name }
            });
            result.output.artifactId = outArtifact.id;
          }

          if (result.output?.filePath) {
            const generated = await this.artifactStore.createFromFile({
              originalPath: result.output.filePath,
              fileName: result.output.fileName || path.basename(result.output.filePath),
              kind: result.output.kind || "file",
              mimeType: result.output.mimeType || "application/octet-stream",
              source: { type: "tool", toolName: params.name },
              metadata: { tool: params.name }
            });
            result.output.artifactId = generated.id;
            await unlink(result.output.filePath).catch(() => {});
          }

          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result
          };
        }
      }),
      defineTool({
        name: "send_media_reply",
        label: "Send media reply",
        description: "Run a CLI tool that generates a file and send it to the current Telegram chat using the tool's delivery hint or an explicit method.",
        parameters: Type.Object({
          text: Type.String(),
          toolName: Type.Optional(Type.String()),
          method: Type.Optional(Type.Union([
            Type.Literal("voice"),
            Type.Literal("audio"),
            Type.Literal("document")
          ]))
        }),
        execute: async (_id, params) => {
          await this.toolRegistry.load();
          const toolName = params.toolName || "openai-tts";
          this.logger?.log("agent", `send_media_reply via ${toolName}`);
          const result = await this.toolRegistry.run({
            name: toolName,
            request: { text: params.text, args: {} }
          });
          if (!result.ok || !result.output?.filePath) {
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
          }
          const method = params.method || result.output?.delivery?.method || "audio";
          await telegram.sendMedia(result.output.filePath, { method, caption: params.text });
          await unlink(result.output.filePath).catch(() => {});
          return {
            content: [{ type: "text", text: `Media sent to Telegram as ${method}.` }],
            details: { ...result, sent: { method } }
          };
        }
      })
    ];
  }
}
