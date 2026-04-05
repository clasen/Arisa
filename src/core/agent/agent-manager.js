import path from "node:path";
import { mkdir } from "node:fs/promises";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const agentDir = path.resolve("data/pi-agent");

function getOAuthProviderForModelProvider(provider) {
  if (provider === "openai-codex") return "openai-codex";
  if (provider === "anthropic") return "anthropic";
  if (provider === "google") return "google-gemini-cli";
  if (provider === "google-antigravity") return "google-antigravity";
  if (provider === "github-copilot") return "github-copilot";
  return provider;
}

function normalizePiConfig(pi) {
  const provider = pi.provider === "codex" ? "openai" : pi.provider;
  let model = pi.model;
  if (pi.provider === "codex") {
    if (model === "5.4") model = "gpt-5.4";
    else if (model === "5.4-mini") model = "gpt-5.4-mini";
    else if (model === "5.4-nano") model = "gpt-5.4-nano";
    else if (model === "5.4-pro") model = "gpt-5.4-pro";
    else if (!model.startsWith("gpt-")) model = `gpt-${model}`;
  }
  return { provider, model };
}

export class AgentManager {
  constructor({ config, artifactStore, toolRegistry }) {
    this.config = config;
    this.artifactStore = artifactStore;
    this.toolRegistry = toolRegistry;
    this.sessions = new Map();
  }

  setConfig(config) {
    this.config = config;
    this.sessions.clear();
  }

  async validatePiAgent() {
    const authStorage = AuthStorage.create();
    const normalized = normalizePiConfig(this.config.pi);
    if (this.config.pi.apiKey) {
      authStorage.setRuntimeApiKey(normalized.provider, this.config.pi.apiKey);
    }

    const modelRegistry = ModelRegistry.create(authStorage);
    const model = modelRegistry.find(normalized.provider, normalized.model);
    if (!model) {
      throw new Error(`Model not found: ${this.config.pi.provider}/${this.config.pi.model} (resolved to ${normalized.provider}/${normalized.model})`);
    }
    const oauthProvider = getOAuthProviderForModelProvider(normalized.provider);
    if (!this.config.pi.apiKey && !modelRegistry.hasConfiguredAuth(normalized.provider) && !authStorage.hasAuth(oauthProvider)) {
      throw new Error(`No auth found for ${normalized.provider}. Provide a Pi API key in bootstrap, or authenticate with the internal /login flow during bootstrap.`);
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
    if (this.sessions.has(chatId)) return this.sessions.get(chatId);

    await mkdir(agentDir, { recursive: true });
    const authStorage = AuthStorage.create();
    const normalized = normalizePiConfig(this.config.pi);
    if (this.config.pi.apiKey) {
      authStorage.setRuntimeApiKey(normalized.provider, this.config.pi.apiKey);
    }
    const modelRegistry = ModelRegistry.create(authStorage);
    const model = modelRegistry.find(normalized.provider, normalized.model);
    if (!model) throw new Error(`Model not found: ${this.config.pi.provider}/${this.config.pi.model} (resolved to ${normalized.provider}/${normalized.model})`);
    const oauthProvider = getOAuthProviderForModelProvider(normalized.provider);
    if (!this.config.pi.apiKey && !modelRegistry.hasConfiguredAuth(normalized.provider) && !authStorage.hasAuth(oauthProvider)) {
      throw new Error(`No auth found for ${normalized.provider}. Re-run bootstrap and complete login for this provider before Telegram starts.`);
    }

    const cwd = path.resolve("data/chats", String(chatId));
    await mkdir(cwd, { recursive: true });

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
        description: "Write a value into cli/<tool>/config.js.",
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
          }

          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result
          };
        }
      }),
      defineTool({
        name: "send_audio_reply",
        label: "Send audio reply",
        description: "Generate speech from text with a CLI tool and send it to the current Telegram chat.",
        parameters: Type.Object({ text: Type.String(), toolName: Type.Optional(Type.String()) }),
        execute: async (_id, params) => {
          await this.toolRegistry.load();
          const toolName = params.toolName || "openai-tts";
          const result = await this.toolRegistry.run({
            name: toolName,
            request: { text: params.text, args: {} }
          });
          if (!result.ok || !result.output?.filePath) {
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
          }
          await telegram.sendAudio(result.output.filePath, params.text);
          return { content: [{ type: "text", text: "Audio enviado por Telegram." }], details: result };
        }
      })
    ];
  }
}
