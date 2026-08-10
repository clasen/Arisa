import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { defaultPrimeVersion } from "../config/config-defaults.js";

const defaultRequestTimeoutMs = 30_000;
const defaultPromptTimeoutMs = 24 * 60 * 60 * 1000;
const defaultCloseTimeoutMs = 5_000;
const defaultTerminateTimeoutMs = 5_000;
const primeRpcSessionClosedCode = "ARISA_PRIME_RPC_SESSION_CLOSED";
const primeDaemonProtocolName = "prime-agent.daemon";
const primeDaemonProtocolVersion = 7;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settlesWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function commandVersion(output) {
  return String(output || "").match(/\bv?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/)?.[1] || "";
}

function isSessionSettled(state) {
  if (
    typeof state?.isStreaming !== "boolean"
    || typeof state?.isCompacting !== "boolean"
    || !state.sessionActions
    || !Number.isInteger(state.sessionActions.queuedCount)
  ) {
    throw new Error("Prime RPC get_state returned an invalid session lifecycle snapshot");
  }
  return !state.isStreaming
    && !state.isCompacting
    && !state.sessionActions.active
    && state.sessionActions.queuedCount === 0;
}

export class PrimeRpcSessionClosedError extends Error {
  constructor(message = "Prime RPC session closed") {
    super(message);
    this.name = "PrimeRpcSessionClosedError";
    this.code = primeRpcSessionClosedCode;
  }
}

export function isPrimeRpcSessionClosedError(error) {
  return error?.code === primeRpcSessionClosedCode;
}

export async function shutdownPrimeDaemon({
  socketPath,
  pid,
  processStartId,
  timeoutMs,
  connectImpl = createConnection
}) {
  if (!String(socketPath || "").trim()) throw new Error("Prime daemon shutdown requires a socketPath");
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Prime daemon shutdown requires a positive PID");
  if (!String(processStartId || "").trim()) {
    throw new Error("Prime daemon shutdown requires a processStartId");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Prime daemon shutdown requires a positive timeoutMs");
  }
  await new Promise((resolve, reject) => {
    const requestId = `arisa_doctor_${crypto.randomUUID()}`;
    const clientId = `arisa-doctor:${crypto.randomUUID()}`;
    const socket = connectImpl(socketPath);
    let buffer = "";
    let shutdownAccepted = false;
    let daemonClosing = false;
    let requestSent = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy?.();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(`Timed out stopping Prime daemon ${pid} on ${socketPath}`));
    }, timeoutMs);
    const handleRecord = (record) => {
      if (record?.type === "daemon_hello" && !requestSent) {
        if (record.supervisorPid !== pid || record.supervisorProcessStartId !== processStartId) {
          finish(new Error(`Prime daemon identity on ${socketPath} did not match PID ${pid}`));
          return;
        }
        if (
          record.protocol?.name !== primeDaemonProtocolName
          || record.protocol?.version !== primeDaemonProtocolVersion
        ) {
          finish(new Error(`Prime daemon on ${socketPath} uses an unsupported control protocol`));
          return;
        }
        requestSent = true;
        socket.write(`${JSON.stringify({
          type: "command",
          id: requestId,
          protocol: { name: primeDaemonProtocolName, version: primeDaemonProtocolVersion },
          clientId,
          command: { type: "shutdown", id: requestId, force: true }
        })}\n`);
        return;
      }
      if (record?.type === "daemon_closing" && record.reason === "shutdown") {
        daemonClosing = true;
        return;
      }
      if (record?.type === "response" && record.id === requestId) {
        if (!record.success) {
          finish(new Error(record.error || `Prime daemon ${pid} rejected shutdown`));
          return;
        }
        shutdownAccepted = true;
      }
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            handleRecord(JSON.parse(line));
          } catch (error) {
            finish(new Error(`Prime daemon on ${socketPath} emitted invalid JSON: ${error.message}`));
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.once("error", (error) => {
      if (shutdownAccepted || daemonClosing) finish();
      else finish(new Error(`Prime daemon shutdown connection failed: ${error.message}`));
    });
    socket.once("close", () => {
      if (shutdownAccepted || daemonClosing) finish();
      else finish(new Error(`Prime daemon ${pid} closed before accepting shutdown`));
    });
  });
}

export async function validatePrimeBinary({ command = "prime-agent", commandArgs = [], expectedVersion = defaultPrimeVersion, spawnImpl = spawn } = {}) {
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
    expectedVersion = defaultPrimeVersion,
    provider,
    model,
    thinkingLevel = "medium",
    cwd,
    agentDir,
    sessionDir,
    kernelVenvDir,
    daemonSocketPath,
    supervisorRegistryDir,
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
    promptTimeoutMs = defaultPromptTimeoutMs,
    closeTimeoutMs = defaultCloseTimeoutMs,
    terminateTimeoutMs = defaultTerminateTimeoutMs
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
    if (!String(daemonSocketPath || "").trim()) {
      throw new Error("Prime RPC session requires a daemonSocketPath");
    }
    if (!String(supervisorRegistryDir || "").trim()) {
      throw new Error("Prime RPC session requires a supervisorRegistryDir");
    }
    this.daemonSocketPath = daemonSocketPath;
    this.supervisorRegistryDir = supervisorRegistryDir;
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
    this.closeTimeoutMs = closeTimeoutMs;
    this.terminateTimeoutMs = terminateTimeoutMs;
    this.listeners = new Set();
    this.pending = new Map();
    this.messages = [];
    this.sessionFile = "";
    this.child = null;
    this.startPromise = null;
    this.promptCompletion = null;
    this.promptInProgress = false;
    this.settlementWaiters = new Set();
    this.settlementCheckPromise = null;
    this.settlementCheckDirty = false;
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

  hasActiveWork() {
    return this.promptInProgress || this.pending.size > 0 || this.settlementWaiters.size > 0;
  }

  buildArgs(shouldContinue) {
    const args = [
      "--daemon-socket", this.daemonSocketPath,
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
      PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR: this.supervisorRegistryDir,
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

    let arisaPromptScoped = Boolean(this.promptCompletion || this.currentCyclePrompted);
    if (record.type === "agent_start") {
      this.currentAgentText = "";
      this.currentCyclePrompted = Boolean(this.promptCompletion);
      arisaPromptScoped = this.currentCyclePrompted;
    }
    if (record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta") {
      this.currentAgentText += record.assistantMessageEvent.delta || "";
    }
    if (record.type === "message_end" && record.message) {
      this.messages.push(record.message);
    }
    if (record.type === "agent_end") {
      const text = this.currentAgentText.trim();
      if (!this.promptCompletion && !this.currentCyclePrompted && text) {
        Promise.resolve(this.onUnsolicitedText?.(text, record)).catch((error) => {
          this.logger?.error?.("prime", `unsolicited reply delivery failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      this.currentAgentText = "";
      this.currentCyclePrompted = false;
    }
    if (["agent_end", "auto_retry_end", "compaction_end", "session_action_update"].includes(record.type)) {
      this.requestSettlementCheck();
    }
    Object.defineProperty(record, "arisaPromptScoped", { value: arisaPromptScoped, enumerable: false });
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

  async getSessionStats({ timeoutMs } = {}) {
    return this.request("get_session_stats", {}, { timeoutMs });
  }

  applyState(state) {
    if (!state) return;
    if (state.model) this.model = state.model;
    if (state.thinkingLevel) this.thinkingLevel = state.thinkingLevel;
    if (state.sessionFile) this.sessionFile = state.sessionFile;
  }

  requestSettlementCheck() {
    this.settlementCheckDirty = true;
    if (this.settlementCheckPromise || !this.child || this.settlementWaiters.size === 0) return;

    const run = async () => {
      while (this.settlementCheckDirty && this.child && this.settlementWaiters.size > 0) {
        this.settlementCheckDirty = false;
        const state = await this.request("get_state");
        this.applyState(state);
        if (this.settlementCheckDirty) continue;
        if (!isSessionSettled(state)) continue;

        const waiters = [...this.settlementWaiters];
        this.settlementWaiters.clear();
        let shouldEmitSettled = false;
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          shouldEmitSettled ||= waiter.emitSettled;
          waiter.resolve(state);
        }
        if (shouldEmitSettled) this.emit({ type: "agent_settled", state });
      }
    };

    this.settlementCheckPromise = run()
      .catch((error) => this.rejectSettlementWaiters(error))
      .finally(() => {
        this.settlementCheckPromise = null;
        if (this.settlementCheckDirty && this.child && this.settlementWaiters.size > 0) {
          this.requestSettlementCheck();
        }
      });
  }

  waitForSessionSettlement(deadline, { emitSettled = false } = {}) {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) return Promise.reject(new Error("Prime RPC prompt timed out"));

    const waiter = deferred();
    waiter.emitSettled = emitSettled;
    waiter.timer = setTimeout(() => {
      this.settlementWaiters.delete(waiter);
      waiter.reject(new Error("Prime RPC prompt timed out"));
    }, timeoutMs);
    waiter.timer.unref?.();
    this.settlementWaiters.add(waiter);
    this.requestSettlementCheck();
    return waiter.promise;
  }

  rejectSettlementWaiters(error) {
    for (const waiter of this.settlementWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.settlementWaiters.clear();
  }

  async prompt(message) {
    if (this.promptInProgress) throw new Error("Prime RPC prompt already in progress");
    this.promptInProgress = true;
    const deadline = Date.now() + this.promptTimeoutMs;
    const completion = {};
    try {
      await this.start();
      await this.waitForSessionSettlement(deadline);
      this.promptCompletion = completion;
      await this.request("prompt", { message, streamingBehavior: "followUp" });
      await this.waitForSessionSettlement(deadline, { emitSettled: true });
    } finally {
      if (this.promptCompletion === completion) this.promptCompletion = null;
      this.promptInProgress = false;
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

  rejectPending(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.rejectSettlementWaiters(error);
    this.promptCompletion = null;
  }

  handleExit(error) {
    const child = this.child;
    this.child = null;
    this.rejectPending(error);
    if (child) this.emit({ type: "runtime_error", error });
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.rejectPending(new PrimeRpcSessionClosedError());
    if (child.exitCode != null || child.signalCode != null) return;

    const closed = new Promise((resolve) => child.once("close", resolve));
    child.stdin?.end();
    if (await settlesWithin(closed, this.closeTimeoutMs)) return;

    child.kill("SIGTERM");
    if (await settlesWithin(closed, this.terminateTimeoutMs)) return;

    child.kill("SIGKILL");
    await closed;
  }
}
