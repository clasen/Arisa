import { spawn } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { authorizeAction, authorizeStaticAction, assertKnownActionTool, normalizeActionLevel } from "./action-policy.js";
import { boundUtf8, normalizeMaxOutputBytes } from "./output-bounds.js";
import { validatePublicUrl } from "./url-security.js";
const urlTools = new Set(["goto", "markdown", "html", "tree", "links", "interactiveElements", "structuredData", "detectForms"]);
const selectorTools = new Set(["click", "fill", "hover", "selectOption", "setChecked"]);

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function parseSteps(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("steps must be a JSON array.");
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("steps must be a non-empty JSON array.");
  if (parsed.length > 20) throw new Error("steps may contain at most 20 operations.");
  return parsed;
}

function normalizeSelector(value, name = "selector") {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  if (value.length > 500) throw new Error(`${name} is too long.`);
  return value;
}

function normalizeArguments(tool, value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${tool} arguments must be an object.`);
  const args = structuredClone(value);
  if (typeof args.selector === "string") normalizeSelector(args.selector);
  if (typeof args.script === "string" && args.script.length > 2_000) throw new Error(`${tool} script is too long.`);
  if (typeof args.value === "string" && Buffer.byteLength(args.value) > 10_000) throw new Error(`${tool} value is too long.`);
  if (typeof args.key === "string" && args.key.length > 32) throw new Error("press key is too long.");
  if (args.timeout !== undefined) args.timeout = boundedInteger(args.timeout, 10_000, 500, 15_000);
  if (args.maxBytes !== undefined) args.maxBytes = boundedInteger(args.maxBytes, 32_768, 1_024, 131_072);
  if (args.limit !== undefined) args.limit = boundedInteger(args.limit, 50, 1, 100);
  if (args.maxDepth !== undefined) args.maxDepth = boundedInteger(args.maxDepth, 5, 1, 20);
  if (tool === "extract") {
    if (typeof args.schema !== "string" || Buffer.byteLength(args.schema) > 32_768) throw new Error("extract schema must be a JSON string no larger than 32 KiB.");
    try {
      const schema = JSON.parse(args.schema);
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error();
    } catch {
      throw new Error("extract schema must encode a JSON object.");
    }
  }
  if (selectorTools.has(tool)) {
    normalizeSelector(args.selector);
    delete args.backendNodeId;
  }
  return args;
}

export async function normalizeInteractionSteps(value, {
  actionLevel: requestedLevel,
  commitIntent,
  allowMutations = false,
  legacyMutations = false,
  lookup
} = {}) {
  const actionLevel = normalizeActionLevel(requestedLevel, { allowMutations, legacyMutations });
  const steps = [];
  for (const [index, raw] of parseSteps(value).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Step ${index + 1} must be an object.`);
    const tool = String(raw.tool || "").trim();
    try { assertKnownActionTool(tool); }
    catch { throw new Error(`Step ${index + 1} uses unsupported tool: ${tool || "(empty)"}.`); }
    const args = normalizeArguments(tool, raw.arguments);
    authorizeStaticAction({ tool, args, actionLevel, commitIntent, legacyMutations });
    if (urlTools.has(tool) && args.url !== undefined) args.url = (await validatePublicUrl(args.url, lookup ? { lookup } : undefined)).href;
    if (tool === "goto") {
      if (!args.url) throw new Error(`Step ${index + 1} (goto) requires url.`);
      args.url = (await validatePublicUrl(args.url, lookup ? { lookup } : undefined)).href;
    }
    steps.push({ tool, arguments: args, actionLevel, commitIntent: String(commitIntent || "").trim().toLowerCase(), legacyMutations });
  }
  return steps;
}

function resultText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((item) => item?.type === "text")
    .map((item) => String(item.text || ""))
    .join("\n");
}

export class McpProcess {
  constructor(binary, command, { timeoutMs, maxCaptureBytes }) {
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = [];
    this.stderrBytes = 0;
    this.maxCaptureBytes = maxCaptureBytes;
    this.child = spawn(binary, command, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH || "", LIGHTPANDA_DISABLE_TELEMETRY: "true" }
    });
    this.peakRssKiB = 0;
    this.sampler = setInterval(() => this.sampleRss(), 20);
    this.sampler.unref?.();
    this.sampleRss();
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.onLine(line));
    this.child.stderr.on("data", (chunk) => this.captureStderr(chunk));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.once("error", (error) => this.fail(error));
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.child.once("close", (code, signal) => {
      this.resolveClosed?.();
      if (!this.closing) this.fail(new Error(`Lightpanda MCP exited (${signal || code}). ${this.stderr.join("").trim()}`));
    });
    this.timer = timeoutMs > 0 ? setTimeout(() => {
      this.child.kill("SIGKILL");
      this.fail(Object.assign(new Error("Lightpanda interaction timed out."), { code: "LIGHTPANDA_TIMEOUT", retryable: true }));
    }, timeoutMs) : null;
    this.timer?.unref?.();
  }

  async sampleRss() {
    try {
      const status = await readFile(`/proc/${this.child.pid}/status`, "utf8");
      this.peakRssKiB = Math.max(this.peakRssKiB, Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0));
    } catch {
      // The short-lived process may exit between samples.
    }
  }

  captureStderr(chunk) {
    if (this.stderrBytes >= this.maxCaptureBytes) return;
    const bounded = chunk.subarray(0, this.maxCaptureBytes - this.stderrBytes);
    this.stderr.push(bounded.toString("utf8"));
    this.stderrBytes += bounded.length;
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(Object.assign(
      new Error(`Lightpanda MCP error: ${message.error.message || JSON.stringify(message.error)}`),
      { code: "LIGHTPANDA_MCP_OPERATION_FAILED", recoverable: true }
    ));
    else pending.resolve(message.result);
  }

  fail(error) {
    if (this.failed) return;
    this.failed = error;
    clearTimeout(this.timer);
    clearInterval(this.sampler);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  send(message) {
    if (this.failed) throw this.failed;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async start() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "arisa-lightpanda-browser", version: "0.11.2" }
    });
    this.notify("notifications/initialized");
  }

  async callResult(tool, args) {
    const result = await this.request("tools/call", { name: tool, arguments: args });
    if (result?.isError) throw Object.assign(
      new Error(`Lightpanda ${tool} failed: ${resultText(result) || "unknown error"}`),
      { code: "LIGHTPANDA_MCP_OPERATION_FAILED", recoverable: true }
    );
    return result;
  }

  async call(tool, args) {
    return resultText(await this.callResult(tool, args));
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    clearTimeout(this.timer);
    clearInterval(this.sampler);
    this.closePromise = (async () => {
      this.lines.close();
      this.child.stdin.end();
      this.child.kill("SIGTERM");
      const force = setTimeout(() => this.child.kill("SIGKILL"), 2_000);
      force.unref?.();
      await this.closed;
      clearTimeout(force);
    })();
    return this.closePromise;
  }
}

function requiredRuntimePath(value, label) {
  const normalized = String(value || "");
  if (!path.isAbsolute(normalized) || normalized.includes("\u0000")) throw new Error(`${label} must be an absolute runtime path.`);
  return normalized;
}

export function buildMcpCommand(config, timeoutMs, runtime = {}) {
  const command = [
    "mcp", "--block-private-networks", "--http-connect-timeout", String(Math.min(10_000, timeoutMs)),
    "--http-timeout", String(Math.min(15_000, timeoutMs)), "--http-max-response-size", String(4 * 1024 * 1024),
    "--http-max-concurrent", "8", "--http-max-host-open", "4", "--v8-max-heap-mb", "64",
    "--watchdog-ms", String(Math.min(15_000, timeoutMs)), "--ws-max-concurrent", "2", "--log-level", "error"
  ];
  const obeyRobots = runtime.authenticated ? config.AUTHENTICATED_OBEY_ROBOTS === true : config.OBEY_ROBOTS !== false;
  if (obeyRobots) command.push("--obey-robots");
  if (runtime.authenticated) {
    command.push(
      "--cookie", requiredRuntimePath(runtime.cookiePath, "cookiePath"),
      "--cookie-jar", requiredRuntimePath(runtime.cookieJarPath, "cookieJarPath"),
      "--load-resources", "iframe",
      "--load-resources", "stylesheet"
    );
  }
  return command;
}

export async function performInteraction({ steps: rawSteps, allowMutations, config, args = {}, binary, lookup }) {
  const steps = await normalizeInteractionSteps(rawSteps, {
    actionLevel: args.actionLevel,
    commitIntent: args.commitIntent,
    allowMutations,
    legacyMutations: allowMutations && !args.actionLevel,
    lookup
  });
  const timeoutMs = boundedInteger(args.timeoutMs ?? config.TIMEOUT_MS, 30_000, 5_000, 60_000);
  const maxOutputBytes = normalizeMaxOutputBytes(args.maxOutputBytes ?? config.MAX_OUTPUT_BYTES);
  const command = buildMcpCommand(config, timeoutMs);
  const client = new McpProcess(binary, command, { timeoutMs: timeoutMs + 2_000, maxCaptureBytes: 32 * 1024 });
  const outputs = [];
  const startedAt = Date.now();
  try {
    await client.start();
    for (const [index, step] of steps.entries()) {
      const stepStartedAt = Date.now();
      try {
        const permission = await authorizeAction({ client, ...step, args: step.arguments });
        const text = await client.call(step.tool, step.arguments);
        outputs.push({ index: index + 1, tool: step.tool, permission, elapsedMs: Date.now() - stepStartedAt, text });
      } catch (error) {
        throw Object.assign(new Error(`Interaction step ${index + 1} (${step.tool}) failed: ${error.message}`), {
          code: error.code || "LIGHTPANDA_INTERACTION_FAILED",
          retryable: error.retryable === true
        });
      }
    }
    const finalUrlText = await client.call("getUrl", {});
    const match = finalUrlText.match(/https?:\/\/\S+/);
    const finalUrl = match ? (await validatePublicUrl(match[0], lookup ? { lookup } : undefined)).href : null;
    const rendered = outputs.map((item) => `## ${item.index}. ${item.tool} (${item.elapsedMs} ms)\n${item.text}`).join("\n\n");
    const bounded = boundUtf8(rendered, maxOutputBytes);
    return {
      text: bounded.text,
      json: {
        engine: "lightpanda",
        mode: "interact",
        operations: outputs.length,
        elapsedMs: Date.now() - startedAt,
        peakProcessRssMiB: client.peakRssKiB ? Number((client.peakRssKiB / 1024).toFixed(1)) : null,
        finalUrl,
        truncated: bounded.truncated,
        bytes: bounded.bytes,
        steps: outputs.map(({ text, ...item }) => ({ ...item, outputBytes: Buffer.byteLength(text) }))
      }
    };
  } finally {
    await client.close();
  }
}
