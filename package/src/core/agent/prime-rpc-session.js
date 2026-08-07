import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

const defaultRequestTimeoutMs = 30_000;
const defaultPromptTimeoutMs = 24 * 60 * 60 * 1000;
const closeTimeoutMs = 5_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function commandVersion(output) {
  return String(output || "").match(/\bv?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/)?.[1] || "";
}

export async function validatePrimeBinary({ command = "prime-agent", commandArgs = [], expectedVersion = "0.7.0", spawnImpl = spawn } = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawnImpl(command, [...commandArgs, "--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  }).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`Prime Agent executable not found: ${command}. Install Prime Agent v${expectedVersion} first.`);
    }
    throw error;
  });

  if (result.exitCode !== 0) {
    throw new Error(`Prime Agent version check failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`);
  }
  const actualVersion = commandVersion(result.stdout || result.stderr);
  if (actualVersion !== expectedVersion) {
    throw new Error(`Unsupported Prime Agent version: ${actualVersion || "unknown"}. Arisa requires exactly ${expectedVersion}.`);
  }
  return { command, version: actualVersion };
}

async function hasPersistedSession(sessionDir) {
  try {
    return (await readdir(sessionDir)).some((name) => name.endsWith(".jsonl"));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export class PrimeRpcSession {
  constructor({
    command = "prime-agent",
    commandArgs = [],
    expectedVersion = "0.7.0",
    provider,
    model,
    thinkingLevel = "medium",
    cwd,
    agentDir,
    sessionDir,
    kernelVenvDir,
    extensionPath,
    chatId,
    continueSession = true,
    noSession = false,
    env = {},
    logger,
    onUiRequest,
    onUnsolicitedText,
    spawnImpl = spawn,
    requestTimeoutMs = defaultRequestTimeoutMs,
    promptTimeoutMs = defaultPromptTimeoutMs
  } = {}) {
    this.command = command;
    this.commandArgs = [...commandArgs];
    this.expectedVersion = expectedVersion;
    this.provider = provider;
    this.model = { provider, id: model, reasoning: true };
    this.thinkingLevel = thinkingLevel;
    this.cwd = cwd;
    this.agentDir = agentDir;
    this.sessionDir = sessionDir;
    this.kernelVenvDir = kernelVenvDir;
    this.extensionPath = extensionPath;
    this.chatId = String(chatId ?? "");
    this.continueSession = continueSession;
    this.noSession = noSession;
    this.extraEnv = env;
    this.logger = logger;
    this.onUiRequest = onUiRequest;
    this.onUnsolicitedText = onUnsolicitedText;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.promptTimeoutMs = promptTimeoutMs;
    this.listeners = new Set();
    this.pending = new Map();
    this.messages = [];
    this.sessionFile = "";
    this.child = null;
    this.startPromise = null;
    this.promptCompletion = null;
    this.currentAgentText = "";
    this.currentCyclePrompted = false;
    this.stderr = "";
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  buildArgs(shouldContinue) {
    const args = [
      "--mode", "rpc",
      "--provider", this.provider,
      "--model", this.model.id,
      "--thinking", this.thinkingLevel,
      "--cwd", this.cwd,
      "--offline"
    ];
    if (this.noSession) {
      args.push("--no-session");
    } else {
      args.push("--session-dir", this.sessionDir);
      if (shouldContinue) args.push("--continue");
    }
    if (this.extensionPath) args.push("--extension", this.extensionPath);
    return args;
  }

  async start() {
    if (this.child) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startProcess() {
    await validatePrimeBinary({
      command: this.command,
      commandArgs: this.commandArgs,
      expectedVersion: this.expectedVersion,
      spawnImpl: this.spawnImpl
    });
    if (!this.noSession) await mkdir(this.sessionDir, { recursive: true });
    await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    const shouldContinue = !this.noSession && this.continueSession && await hasPersistedSession(this.sessionDir);
    const env = {
      ...process.env,
      ...this.extraEnv,
      PRIME_AGENT_CODING_AGENT_DIR: this.agentDir,
      PRIME_AGENT_SESSION_DIR: this.sessionDir,
      ...(this.kernelVenvDir ? { PRIME_AGENT_KERNEL_VENV: this.kernelVenvDir } : {}),
      ARISA_CHAT_ID: this.chatId,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1"
    };
    const child = this.spawnImpl(this.command, [...this.commandArgs, ...this.buildArgs(shouldContinue)], {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    this.attachReader(child.stdout);
    child.stderr?.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-16_384);
    });
    child.once("error", (error) => this.handleExit(error));
    child.once("close", (code, signal) => {
      if (this.child === child) {
        this.handleExit(new Error(`Prime RPC exited${signal ? ` with ${signal}` : ` with code ${code}`}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
      }
    });

    const state = await this.request("get_state", {}, { timeoutMs: 60_000 });
    this.applyState(state);
    const history = await this.request("get_messages").catch(() => null);
    if (history?.messages) this.messages = history.messages;
  }

  attachReader(stream) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line) this.handleLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    });
    stream.on("end", () => {
      buffer += decoder.end();
      if (buffer) this.handleLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    });
  }

  handleLine(line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      const child = this.child;
      this.handleExit(new Error(`Prime RPC emitted invalid JSON: ${error.message}`));
      child?.kill?.("SIGTERM");
      return;
    }

    if (record.type === "response" && record.id && this.pending.has(record.id)) {
      const pending = this.pending.get(record.id);
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.success) pending.resolve(record.data);
      else pending.reject(new Error(record.error || `Prime RPC ${record.command || "command"} failed`));
      return;
    }

    if (record.type === "extension_ui_request") {
      this.handleUiRequest(record);
      return;
    }

    if (record.type === "agent_start") {
      this.currentAgentText = "";
      this.currentCyclePrompted = Boolean(this.promptCompletion);
    }
    if (record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta") {
      this.currentAgentText += record.assistantMessageEvent.delta || "";
    }
    if (record.type === "message_end" && record.message) {
      this.messages.push(record.message);
    }
    if (record.type === "agent_end") {
      const text = this.currentAgentText.trim();
      if (this.promptCompletion) {
        const completion = this.promptCompletion;
        this.promptCompletion = null;
        clearTimeout(completion.timer);
        completion.resolve(record);
      } else if (!this.currentCyclePrompted && text) {
        Promise.resolve(this.onUnsolicitedText?.(text, record)).catch((error) => {
          this.logger?.error?.("prime", `unsolicited reply delivery failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      this.currentAgentText = "";
      this.currentCyclePrompted = false;
    }
    this.emit(record);
  }

  async handleUiRequest(request) {
    try {
      const response = await this.onUiRequest?.(request);
      if (["select", "input", "editor", "confirm"].includes(request.method)) {
        this.write({ type: "extension_ui_response", id: request.id, ...(response || { cancelled: true }) });
      }
    } catch (error) {
      this.logger?.error?.("prime", `RPC UI request failed: ${error instanceof Error ? error.message : String(error)}`);
      this.write({ type: "extension_ui_response", id: request.id, cancelled: true });
    }
  }

  write(record) {
    if (!this.child?.stdin?.writable) throw new Error("Prime RPC is not running");
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  async request(type, fields = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.child && type !== "get_state") await this.start();
    const id = crypto.randomUUID();
    const pending = deferred();
    pending.timer = setTimeout(() => {
      this.pending.delete(id);
      pending.reject(new Error(`Prime RPC ${type} timed out`));
    }, timeoutMs);
    pending.timer.unref?.();
    this.pending.set(id, pending);
    this.write({ id, type, ...fields });
    return pending.promise;
  }

  applyState(state) {
    if (!state) return;
    if (state.model) this.model = state.model;
    if (state.thinkingLevel) this.thinkingLevel = state.thinkingLevel;
    if (state.sessionFile) this.sessionFile = state.sessionFile;
  }

  async prompt(message) {
    await this.start();
    if (this.promptCompletion) throw new Error("Prime RPC prompt already in progress");
    const completion = deferred();
    completion.timer = setTimeout(() => {
      if (this.promptCompletion === completion) this.promptCompletion = null;
      completion.reject(new Error("Prime RPC prompt timed out"));
    }, this.promptTimeoutMs);
    completion.timer.unref?.();
    this.promptCompletion = completion;
    try {
      await this.request("prompt", { message });
      await completion.promise;
      const state = await this.request("get_state").catch(() => null);
      this.applyState(state);
    } catch (error) {
      if (this.promptCompletion === completion) this.promptCompletion = null;
      clearTimeout(completion.timer);
      throw error;
    }
  }

  async setThinkingLevel(level) {
    this.thinkingLevel = level;
    if (this.child) {
      await this.request("set_thinking_level", { level });
    }
  }

  async getAvailableModels() {
    await this.start();
    return (await this.request("get_available_models"))?.models || [];
  }

  async setModel(provider, modelId) {
    await this.start();
    const model = await this.request("set_model", { provider, modelId });
    this.model = model?.model || model || { provider, id: modelId, reasoning: true };
    return this.model;
  }

  respondToUi(id, response) {
    this.write({ type: "extension_ui_response", id, ...response });
  }

  handleExit(error) {
    const child = this.child;
    this.child = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (this.promptCompletion) {
      clearTimeout(this.promptCompletion.timer);
      this.promptCompletion.reject(error);
      this.promptCompletion = null;
    }
    if (child) this.emit({ type: "runtime_error", error });
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.stdin?.end();
    let closeTimer;
    await Promise.race([
      closed,
      new Promise((resolve) => { closeTimer = setTimeout(resolve, closeTimeoutMs); })
    ]);
    clearTimeout(closeTimer);
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
  }
}
