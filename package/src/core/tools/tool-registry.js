import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { arisaIpcSocketFile, arisaPackageDir, getToolConfigPath, getToolStateDir, getToolTmpDir, getChatToolTmpDir, toolsDir as userToolsRoot } from "../../runtime/paths.js";
import { loadToolConfig, parseConfigModule, writeToolConfig } from "./tool-config.js";
import { normalizeToolResult } from "./tool-result.js";
import { readDaemonDiagnostic } from "./daemon-processes.js";
import { createDaemonRuntime, DAEMON_EVENT_TYPES, DAEMON_PROTOCOL_VERSION } from "./daemon-runtime.js";
import { daemonConfigDefaults } from "../config/config-defaults.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { ToolUsageStore } from "./tool-usage-store.js";

function toolEnv() {
  return { ...process.env, ARISA_PACKAGE_DIR: arisaPackageDir, ARISA_IPC_SOCKET: arisaIpcSocketFile };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function requirementNames(requirements) {
  if (Array.isArray(requirements)) {
    return requirements.map((item) => typeof item === "string" ? item : item?.name).filter(Boolean);
  }
  if (requirements && typeof requirements === "object") return Object.keys(requirements);
  return [];
}

export function createToolOutputParser(name, { onEvent, maxFrameBytes = 1_048_576 } = {}) {
  let buffer = "";
  let mode = "unknown";
  let rawOutput = "";
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
      if (mode !== "ndjson") rawOutput += text;
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

async function runToolProcess(command, args, { onEvent, maxFrameBytes, ...options } = {}) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const parser = createToolOutputParser(path.basename(args[0] || command), { onEvent, maxFrameBytes });
  const stderrChunks = [];
  let stderrBytes = 0;
  const stdoutTask = (async () => {
    for await (const chunk of child.stdout) await parser.push(chunk);
    return parser.finish();
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
  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdout.resume();
  child.stderr.resume();
  const code = await exitPromise;
  const [parsed, stderr] = await Promise.all([stdoutTask, stderrTask]);
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
  constructor({ logger, usageStore = new ToolUsageStore(), resolveOfficialToolNames = readOfficialToolNames } = {}) {
    this.logger = logger;
    this.tools = new Map();
    this.skillRegistry = new SkillRegistry();
    this.usageStore = usageStore;
    this.resolveOfficialToolNames = resolveOfficialToolNames;
  }

  async load() {
    this.tools.clear();

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
        if (this.tools.has(manifest.name)) continue;
        const configSource = await readFile(configPath, "utf8");
        const defaults = parseConfigModule(configSource);
        const config = await loadToolConfig(manifest.name, defaults);
        const skillHints = this.skillRegistry.normalizeHints(manifest);
        this.tools.set(manifest.name, {
          ...manifest,
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

    this.logger?.log("tools", `loaded ${this.tools.size} tool(s)`);
  }

  list() {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      version: typeof tool.version === "string" ? tool.version : null,
      packageDigest: typeof tool.packageDigest === "string" ? tool.packageDigest : null,
      requirements: requirementNames(tool.requirements),
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
    const result = await runProcess("node", [tool.entry, "--help"], { cwd: tool.dir, env: toolEnv() });
    const help = result.stdout || result.stderr;
    const skills = await this.resolveSkills(name);
    const sections = [
      help.trimEnd(),
      formatSemanticMetadata(tool)
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

  async run({ name, request, chatId = null, onEvent = null }) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    await this.usageStore.record(chatId, name).catch((error) => {
      this.logger?.error("tools", `could not record ${name} usage: ${error?.message || String(error)}`);
    });
    this.logger?.log("tools", `running ${name}`);
    const tmpDir = chatId != null ? getChatToolTmpDir(chatId, name) : getToolTmpDir(name);
    await mkdir(tmpDir, { recursive: true });
    const requestFile = path.join(tmpDir, `.request-${Date.now()}-${randomUUID()}.json`);
    const skills = await this.resolveSkills(name);
    const enrichedRequest = { ...request, chatId, skills };
    let result;
    try {
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
        const processResult = await runToolProcess("node", [tool.entry, "run", "--request-file", requestFile], {
          cwd: tool.dir,
          env: toolEnv(),
          onEvent,
          maxFrameBytes: daemonConfigDefaults.ipcFrameBytes
        });
        if (processResult.stderr.trim()) {
          this.logger?.log("tools", `${name} stderr: ${processResult.stderr.trim()}`);
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
      return normalizeToolResult(name, {
        ok: false,
        error: error?.message || `Invalid tool response for ${name}`
      });
    } finally {
      await unlink(requestFile).catch(() => {});
      await rmdir(tmpDir).catch(() => {});
      if (chatId != null) {
        await rmdir(path.dirname(tmpDir)).catch(() => {});
        await rmdir(path.dirname(path.dirname(tmpDir))).catch(() => {});
      }
    }
  }
}
