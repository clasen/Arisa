import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { arisaIpcSocketFile, arisaPackageDir, getToolConfigPath, getToolStateDir, getToolTmpDir, getChatToolTmpDir, toolsDir as userToolsRoot } from "../../runtime/paths.js";
import { loadToolConfig, parseConfigModule, writeToolConfig } from "./tool-config.js";
import { normalizeToolResult } from "./tool-result.js";
import { readDaemonDiagnostic } from "./daemon-processes.js";
import { createDaemonRuntime, DAEMON_EVENT_TYPES, DAEMON_PROTOCOL_VERSION } from "./daemon-runtime.js";
import { daemonConfigDefaults } from "../config/config-defaults.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { ToolUsageStore } from "./tool-usage-store.js";
import { inspectToolDependencies, normalizeToolDependencies } from "./tool-dependencies.js";
import { normalizeToolExecution, WeightedResourceGovernor } from "./weighted-resource-governor.js";

function toolEnv() {
  return { ...process.env, ARISA_PACKAGE_DIR: arisaPackageDir, ARISA_IPC_SOCKET: arisaIpcSocketFile };
}

export function isolatedToolProcessInvocation(nodeArgs, execution, {
  platform = process.platform,
  systemdAvailable = existsSync("/run/systemd/system"),
  oomAdjustAvailable = existsSync("/usr/bin/choom")
} = {}) {
  if (!execution?.maxMemoryMb || platform !== "linux" || !systemdAvailable) {
    return { command: "node", args: nodeArgs, isolated: false };
  }
  return {
    command: "systemd-run",
    args: [
      "--scope",
      "--quiet",
      "--collect",
      "-p", `MemoryMax=${execution.maxMemoryMb}M`,
      "-p", "MemorySwapMax=0",
      "--",
      ...(oomAdjustAvailable ? ["choom", "-n", "500", "--"] : []),
      "node",
      ...nodeArgs
    ],
    isolated: true
  };
}

const defaultToolHelpTimeoutMs = 10_000;
const defaultToolRunTimeoutMs = 30 * 60_000;
const defaultToolKillGraceMs = 2_000;

function positiveDuration(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function canonicalRequestValue(value) {
  if (Array.isArray(value)) return value.map(canonicalRequestValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalRequestValue(value[key])]));
  }
  return value === undefined ? null : value;
}

function concurrentExecutionKey(name, chatId, request) {
  const serialized = JSON.stringify(canonicalRequestValue({ name, chatId: chatId == null ? null : String(chatId), request }));
  return createHash("sha256").update(serialized).digest("hex");
}

function terminateToolProcess(child, signal) {
  if (process.platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}

function waitForToolProcess(child, { timeoutMs, killGraceMs, label }) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let forceTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateToolProcess(child, "SIGTERM");
      forceTimer = setTimeout(() => terminateToolProcess(child, "SIGKILL"), killGraceMs);
    }, timeoutMs);

    const finish = (callback, value) => {
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      callback(value);
    };

    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      if (!timedOut) {
        finish(resolve, code);
        return;
      }
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = "TOOL_PROCESS_TIMEOUT";
      finish(reject, error);
    });
  });
}

async function runProcess(command, args, {
  timeoutMs,
  killGraceMs,
  label,
  maxOutputBytes = daemonConfigDefaults.ipcFrameBytes,
  ...options
} = {}) {
  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    ...options,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let outputError = null;
  let forceTimer = null;
  const append = (current, chunk) => {
    if (outputError) return current;
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) {
      outputError = new Error(`${label} output exceeds ${maxOutputBytes} bytes`);
      outputError.code = "TOOL_OUTPUT_LIMIT";
      terminateToolProcess(child, "SIGTERM");
      forceTimer = setTimeout(() => terminateToolProcess(child, "SIGKILL"), killGraceMs);
      forceTimer.unref?.();
      return current;
    }
    return current + chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  const code = await waitForToolProcess(child, { timeoutMs, killGraceMs, label });
  clearTimeout(forceTimer);
  if (outputError) throw outputError;
  return { code, stdout, stderr };
}

function requirementNames(requirements) {
  if (Array.isArray(requirements)) {
    return requirements.map((item) => typeof item === "string" ? item : item?.name).filter(Boolean);
  }
  if (requirements && typeof requirements === "object") return Object.keys(requirements);
  return [];
}

export function createToolOutputParser(name, {
  onEvent,
  maxFrameBytes = 1_048_576,
  maxOutputBytes = maxFrameBytes
} = {}) {
  let buffer = "";
  let mode = "unknown";
  let rawOutput = "";
  let rawOutputBytes = 0;
  let terminalResult = null;
  let activeJobId = null;
  let sequence = 0;
  let terminalSeen = false;

  async function parseEvent(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`Invalid NDJSON from ${name}`);
    }
    if (event?.version !== DAEMON_PROTOCOL_VERSION || !DAEMON_EVENT_TYPES.includes(event?.type)) {
      throw new Error(`Invalid versioned tool event from ${name}`);
    }
    if (typeof event.jobId !== "string" || !event.jobId) throw new Error(`Tool event from ${name} is missing jobId`);
    if (activeJobId == null) activeJobId = event.jobId;
    if (event.jobId !== activeJobId) throw new Error(`Tool ${name} multiplexed an unexpected jobId`);
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== sequence + 1) {
      throw new Error(`Invalid tool event sequence from ${name}: ${event.sequence}`);
    }
    if (terminalSeen) throw new Error(`Tool ${name} emitted more than one terminal event`);
    sequence = event.sequence;
    terminalSeen = event.type === "completed" || event.type === "failed";
    await onEvent?.(event);
    if (terminalSeen) {
      terminalResult = event.type === "completed"
        ? event.payload?.result ?? event.payload?.output ?? event.payload
        : { ok: false, error: event.payload?.error || `Tool failed: ${name}`, ...(event.payload?.code ? { code: event.payload.code } : {}) };
    }
  }

  async function consumeLine(line) {
    if (Buffer.byteLength(line, "utf8") > maxFrameBytes) throw new Error(`Tool event from ${name} exceeds ${maxFrameBytes} bytes`);
    if (mode === "unknown") {
      let candidate;
      try {
        candidate = JSON.parse(line);
      } catch {
        mode = "legacy";
        return;
      }
      if (candidate?.version === DAEMON_PROTOCOL_VERSION && DAEMON_EVENT_TYPES.includes(candidate?.type)) {
        mode = "ndjson";
        rawOutput = "";
        return parseEvent(line);
      }
      mode = "legacy";
      return;
    }
    if (mode === "legacy") return;
    return parseEvent(line);
  }

  return {
    async push(chunk) {
      const text = chunk.toString("utf8");
      if (mode !== "ndjson") {
        rawOutputBytes += Buffer.byteLength(text, "utf8");
        if (rawOutputBytes > maxOutputBytes) {
          const error = new Error(`Tool output from ${name} exceeds ${maxOutputBytes} bytes`);
          error.code = "TOOL_OUTPUT_LIMIT";
          throw error;
        }
        rawOutput += text;
      }
      if (mode === "legacy") return;
      buffer += text;
      if (Buffer.byteLength(buffer, "utf8") > maxFrameBytes && !buffer.includes("\n")) {
        throw new Error(`Tool event from ${name} exceeds ${maxFrameBytes} bytes`);
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) await consumeLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    async finish() {
      const tail = buffer.trim();
      buffer = "";
      if (tail) await consumeLine(tail);
      if (mode !== "ndjson") return { mode: "legacy", output: rawOutput };
      if (!terminalSeen) throw new Error(`Tool ${name} ended without a terminal event`);
      return { mode: "ndjson", result: terminalResult };
    }
  };
}

async function runToolProcess(command, args, {
  onEvent,
  maxFrameBytes,
  maxOutputBytes,
  parserName,
  timeoutMs,
  killGraceMs,
  label,
  ...options
} = {}) {
  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    ...options,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const parser = createToolOutputParser(parserName || path.basename(args[0] || command), { onEvent, maxFrameBytes, maxOutputBytes });
  const stderrChunks = [];
  let stderrBytes = 0;
  let stdoutError = null;
  let outputForceTimer = null;
  const stdoutTask = (async () => {
    try {
      for await (const chunk of child.stdout) await parser.push(chunk);
      return parser.finish();
    } catch (error) {
      stdoutError = error;
      terminateToolProcess(child, "SIGTERM");
      outputForceTimer = setTimeout(() => terminateToolProcess(child, "SIGKILL"), killGraceMs);
      outputForceTimer.unref?.();
      return null;
    }
  })();
  const stderrTask = (async () => {
    for await (const chunk of child.stderr) {
      if (stderrBytes >= maxFrameBytes) continue;
      const accepted = chunk.subarray(0, maxFrameBytes - stderrBytes);
      stderrChunks.push(accepted);
      stderrBytes += accepted.length;
    }
    return Buffer.concat(stderrChunks).toString("utf8");
  })();
  child.stdout.resume();
  child.stderr.resume();
  let code;
  try {
    code = await waitForToolProcess(child, { timeoutMs, killGraceMs, label });
  } catch (error) {
    await Promise.allSettled([stdoutTask, stderrTask]);
    throw error;
  }
  const [parsed, stderr] = await Promise.all([stdoutTask, stderrTask]);
  clearTimeout(outputForceTimer);
  if (stdoutError) throw stdoutError;
  return { code, parsed, stderr };
}

function normalizeCategory(category) {
  if (typeof category !== "string") return null;
  const trimmed = category.trim();
  return trimmed || null;
}

function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) return [];
  return [...new Set(keywords
    .filter((keyword) => typeof keyword === "string")
    .map((keyword) => keyword.trim())
    .filter(Boolean))];
}

function searchableToolText(tool) {
  return [
    tool.name,
    tool.description,
    tool.category,
    ...(tool.keywords || []),
    ...(tool.input || []),
    ...(tool.output || [])
  ].filter(Boolean).join(" ").toLowerCase();
}

export function rankToolMatches(tools, query) {
  const terms = String(query || "").toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
  if (!terms.length) return [];
  return tools.map((tool) => {
    const name = String(tool.name || "").toLowerCase();
    const category = String(tool.category || "").toLowerCase();
    const keywords = (tool.keywords || []).map((keyword) => String(keyword).toLowerCase());
    const haystack = searchableToolText(tool);
    let score = 0;
    for (const term of terms) {
      if (keywords.includes(term)) score += 12;
      else if (name === term) score += 10;
      else if (name.includes(term)) score += 7;
      else if (category === term) score += 6;
      else if (haystack.includes(term)) score += 2;
    }
    return { tool, score };
  }).filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
}

function formatSemanticMetadata(tool) {
  return [
    "Semantic metadata:",
    `- category: ${tool.category || "none"}`,
    `- keywords: ${tool.keywords?.length ? tool.keywords.join(", ") : "none"}`
  ].join("\n");
}

function formatToolDependencies(tool, tools) {
  const dependencies = Object.entries(tool.toolDependencies || {});
  if (!dependencies.length) return null;
  const lines = dependencies.map(([name, range]) => {
    const issue = inspectToolDependencies(tools, tool.name).find((item) => item.dependency === name);
    return `- ${name}@${range}: ${issue ? issue.type : "ready"}`;
  });
  return `Tool dependencies:\n${lines.join("\n")}`;
}

async function readOfficialToolNames() {
  const baselinesDir = path.join(getToolStateDir("official-tool-sync"), "baselines");
  try {
    const entries = await readdir(baselinesDir, { withFileTypes: true });
    return new Set(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5)));
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
}

export class ToolRegistry {
  constructor({
    logger,
    usageStore = new ToolUsageStore(),
    resolveOfficialToolNames = readOfficialToolNames,
    helpTimeoutMs = defaultToolHelpTimeoutMs,
    runTimeoutMs = defaultToolRunTimeoutMs,
    killGraceMs = defaultToolKillGraceMs,
    executionPolicy,
    executionGovernor
  } = {}) {
    this.logger = logger;
    this.helpTimeoutMs = positiveDuration(helpTimeoutMs, defaultToolHelpTimeoutMs);
    this.runTimeoutMs = positiveDuration(runTimeoutMs, defaultToolRunTimeoutMs);
    this.killGraceMs = positiveDuration(killGraceMs, defaultToolKillGraceMs);
    this.tools = new Map();
    this.skillRegistry = new SkillRegistry();
    this.usageStore = usageStore;
    this.resolveOfficialToolNames = resolveOfficialToolNames;
    this.executionGovernor = executionGovernor || new WeightedResourceGovernor({
      policy: executionPolicy,
      logger
    });
    this.concurrentExecutions = new Map();
  }

  async buildSnapshot() {
    const snapshot = new Map();
    let entries = [];
    try {
      entries = await readdir(userToolsRoot, { withFileTypes: true });
    } catch {
      this.logger?.log("tools", `tools directory not found: ${userToolsRoot}`);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const toolDir = path.join(userToolsRoot, entry.name);
      const manifestPath = path.join(toolDir, "tool.manifest.json");
      const configPath = path.join(toolDir, "config.js");
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (snapshot.has(manifest.name)) continue;
        const configSource = await readFile(configPath, "utf8");
        const defaults = parseConfigModule(configSource);
        const config = await loadToolConfig(manifest.name, defaults);
        const skillHints = this.skillRegistry.normalizeHints(manifest);
        snapshot.set(manifest.name, {
          ...manifest,
          toolDependencies: normalizeToolDependencies(manifest.toolDependencies),
          execution: normalizeToolExecution(manifest.execution),
          category: normalizeCategory(manifest.category),
          keywords: normalizeKeywords(manifest.keywords),
          skillHints,
          dir: toolDir,
          entry: path.join(toolDir, manifest.entry || "index.js"),
          localConfigPath: configPath,
          configPath: getToolConfigPath(manifest.name),
          defaults,
          config
        });
      } catch {
        // ignore invalid tool dirs in v1
      }
    }
    return snapshot;
  }

  async load() {
    const snapshot = await this.buildSnapshot();
    this.tools = snapshot;
    this.logger?.log("tools", `loaded ${snapshot.size} tool(s)`);
  }

  list() {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      version: typeof tool.version === "string" ? tool.version : null,
      packageDigest: typeof tool.packageDigest === "string" ? tool.packageDigest : null,
      requirements: requirementNames(tool.requirements),
      toolDependencies: tool.toolDependencies || {},
      description: tool.description,
      input: tool.input,
      output: tool.output,
      configSchema: tool.configSchema || {},
      category: tool.category,
      keywords: tool.keywords || [],
      skillHints: tool.skillHints || []
    }));
  }

  search(query) {
    return rankToolMatches(this.list(), query).map(({ tool, score }) => ({ ...tool, score }));
  }

  async listWithRuntime(chatId = null) {
    return Promise.all(this.list().map(async (listedTool) => {
      const daemon = this.get(listedTool.name)?.daemon;
      if (!daemon) return listedTool;
      if (daemon.scope === "chat" && (chatId == null || chatId === "")) {
        throw new Error(`Daemon status for ${listedTool.name} requires chatId`);
      }
      const scope = daemon.scope === "chat"
        ? { type: "chat", chatId }
        : { type: "global" };
      return {
        ...listedTool,
        daemon: {
          scope: daemon.scope,
          autoStart: Boolean(daemon.autoStart),
          health: daemon.health || null,
          runtime: await readDaemonDiagnostic({
            toolName: listedTool.name,
            scope,
            autoStart: daemon.autoStart
          })
        }
      };
    }));
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  async help(name) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    const helpHeapMb = tool.execution?.maxHeapMb || 192;
    const result = await runProcess("node", [`--max-old-space-size=${helpHeapMb}`, tool.entry, "--help"], {
      cwd: tool.dir,
      env: toolEnv(),
      timeoutMs: this.helpTimeoutMs,
      killGraceMs: this.killGraceMs,
      maxOutputBytes: tool.execution?.maxOutputBytes || daemonConfigDefaults.ipcFrameBytes,
      label: `Tool help for ${name}`
    });
    const help = result.stdout || result.stderr;
    const skills = await this.resolveSkills(name);
    const sections = [
      help.trimEnd(),
      formatSemanticMetadata(tool),
      formatToolDependencies(tool, this.tools)
    ];
    if (skills.length) {
      const skillHelp = skills.map((item) => [
        `- ${item.name}${item.when ? ` (${item.when})` : ""}`,
        item.description ? `  ${item.description}` : null,
        item.found ? `  path: ${item.path}` : "  warning: skill not found"
      ].filter(Boolean).join("\n")).join("\n");
      sections.push(`Assigned skills:\n${skillHelp}`);
    }
    return `${sections.filter(Boolean).join("\n\n")}\n`;
  }

  async resolveSkills(name) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    const hints = await this.skillRegistry.resolveHints(tool.skillHints || []);
    return hints.map((hint) => ({
      name: hint.name,
      when: hint.when,
      found: hint.found,
      description: hint.skill?.description || "",
      path: hint.skill?.path || "",
      content: hint.skill?.content || ""
    }));
  }

  async resolveConfigForChat(name, chatId) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    if (chatId == null) return tool.config || {};
    return loadToolConfig(name, tool.defaults || {}, chatId);
  }

  async setConfig(name, field, value, chatId = null) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    const current = chatId != null
      ? await this.resolveConfigForChat(name, chatId)
      : { ...(tool.config || {}) };
    current[field] = value;
    const configPath = await writeToolConfig(name, current, chatId);
    if (chatId == null) {
      tool.config = current;
      tool.configPath = configPath;
    }
    return { ok: true, tool: name, field, configPath };
  }

  dependencyIssues(name = null) {
    return inspectToolDependencies(this.tools, name);
  }

  executionDiagnostic() {
    return this.executionGovernor.snapshot();
  }

  async usage(chatId) {
    const [counts, officialNames] = await Promise.all([
      this.usageStore.counts(chatId),
      this.resolveOfficialToolNames()
    ]);
    const names = new Set([
      ...this.list().map((tool) => tool.name),
      ...Object.keys(counts)
    ]);
    return [...names]
      .map((name) => ({ name, count: counts[name] || 0, official: officialNames.has(name) }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async run(invocation) {
    const tool = this.get(invocation.name);
    if (!tool?.execution?.deduplicateConcurrent) return this.runOnce(invocation);
    const key = concurrentExecutionKey(invocation.name, invocation.chatId, invocation.request);
    const active = this.concurrentExecutions.get(key);
    if (active) {
      this.logger?.log("tools", `joined concurrent duplicate ${invocation.name}`);
      return active;
    }
    const execution = this.runOnce(invocation);
    this.concurrentExecutions.set(key, execution);
    try {
      return await execution;
    } finally {
      if (this.concurrentExecutions.get(key) === execution) this.concurrentExecutions.delete(key);
    }
  }

  async runOnce({ name, request, chatId = null, onEvent = null }) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    const dependencyIssue = this.dependencyIssues(name)[0];
    if (dependencyIssue) {
      const version = dependencyIssue.installedVersion ? `; installed ${dependencyIssue.installedVersion}` : "";
      throw new Error(`Tool dependency ${dependencyIssue.type}: ${dependencyIssue.tool} requires ${dependencyIssue.dependency}@${dependencyIssue.range || "valid"}${version}`);
    }
    await this.usageStore.record(chatId, name).catch((error) => {
      this.logger?.error("tools", `could not record ${name} usage: ${error?.message || String(error)}`);
    });
    const tmpDir = chatId != null ? getChatToolTmpDir(chatId, name) : getToolTmpDir(name);
    const requestFile = path.join(tmpDir, `.request-${Date.now()}-${randomUUID()}.json`);
    let lease = null;
    let result;
    try {
      lease = await this.executionGovernor.acquire(tool.execution, name);
      this.logger?.log("tools", `running ${name}`);
      await mkdir(tmpDir, { recursive: true });
      const skills = await this.resolveSkills(name);
      const enrichedRequest = { ...request, chatId, skills };
      if (tool.daemon?.protocol === "arisa-daemon-v1") {
        const scope = tool.daemon.scope === "chat"
          ? { type: "chat", chatId }
          : { type: "global" };
        const runtime = createDaemonRuntime({
          toolName: name,
          entryPath: tool.entry,
          scope,
          startupContext: scope.type === "chat" ? { chatId: String(chatId) } : {},
          autoStart: Boolean(tool.daemon.autoStart)
        });
        result = await runtime.submit(enrichedRequest, { onEvent });
      } else {
        await writeFile(requestFile, `${JSON.stringify(enrichedRequest, null, 2)}\n`, "utf8");
        const nodeArgs = tool.execution?.maxHeapMb
          ? [`--max-old-space-size=${tool.execution.maxHeapMb}`, tool.entry, "run", "--request-file", requestFile]
          : [tool.entry, "run", "--request-file", requestFile];
        const processInvocation = isolatedToolProcessInvocation(nodeArgs, tool.execution);
        if (processInvocation.isolated) {
          this.logger?.log("tools", `${name} isolated at ${tool.execution.maxMemoryMb} MiB total memory`);
        }
        const processResult = await runToolProcess(processInvocation.command, processInvocation.args, {
          cwd: tool.dir,
          env: toolEnv(),
          onEvent,
          parserName: name,
          maxFrameBytes: daemonConfigDefaults.ipcFrameBytes,
          maxOutputBytes: tool.execution?.maxOutputBytes || daemonConfigDefaults.ipcFrameBytes,
          timeoutMs: this.runTimeoutMs,
          killGraceMs: this.killGraceMs,
          label: `Tool run for ${name}`
        });
        if (processResult.stderr.trim()) {
          this.logger?.log("tools", `${name} stderr: ${processResult.stderr.trim()}`);
        }
        if (processResult.code !== 0) {
          const memoryLimited = /heap limit|heap out of memory|allocation failed.*memory|memory cgroup out of memory|\bkilled\b/i.test(processResult.stderr)
            || (processInvocation.isolated && [9, 134, 137].includes(processResult.code));
          const error = new Error(memoryLimited
            ? `Tool ${name} exceeded its isolated memory limit`
            : `Tool ${name} exited with code ${processResult.code}`);
          error.code = memoryLimited ? "TOOL_PROCESS_MEMORY_LIMIT" : "TOOL_PROCESS_EXIT";
          throw error;
        }
        result = processResult.parsed.mode === "ndjson"
          ? processResult.parsed.result
          : JSON.parse(processResult.parsed.output);
      }
      const normalized = normalizeToolResult(name, result);
      if (normalized.ok === false) {
        this.logger?.log("tools", `${name} -> ${normalized.status || "error"}: ${normalized.error || "unknown error"}`);
      } else {
        this.logger?.log("tools", `${name} -> ok`);
      }
      return normalized;
    } catch (error) {
      if (error?.code === "TOOL_RESOURCE_PRESSURE") {
        return normalizeToolResult(name, {
          ok: false,
          status: "retryable",
          error: error.message,
          resolution: {
            type: "retry_later",
            retry: true,
            message: "The tool was not started. Retry after host memory pressure falls."
          }
        });
      }
      if (["TOOL_PROCESS_TIMEOUT", "TOOL_OUTPUT_LIMIT", "TOOL_PROCESS_MEMORY_LIMIT", "TOOL_PROCESS_EXIT"].includes(error?.code)) {
        return normalizeToolResult(name, {
          ok: false,
          status: "outcome_uncertain",
          error: error.message,
          resolution: {
            type: "status_check_required",
            retry: false,
            message: "The isolated tool process ended without a confirmed result. Check external state before retrying."
          }
        });
      }
      return normalizeToolResult(name, {
        ok: false,
        error: error?.message || `Invalid tool response for ${name}`
      });
    } finally {
      lease?.release();
      await unlink(requestFile).catch(() => {});
      await rmdir(tmpDir).catch(() => {});
      if (chatId != null) {
        await rmdir(path.dirname(tmpDir)).catch(() => {});
        await rmdir(path.dirname(path.dirname(tmpDir))).catch(() => {});
      }
    }
  }
}
