import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { arisaIpcSocketFile, arisaPackageDir, getToolConfigPath, getToolTmpDir, getChatToolTmpDir, toolsDir as userToolsRoot } from "../../runtime/paths.js";
import { loadToolConfig, parseConfigModule, writeToolConfig } from "./tool-config.js";
import { normalizeToolResult } from "./tool-result.js";
import { readDaemonDiagnostic } from "./daemon-processes.js";
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

function formatSemanticMetadata(tool) {
  return [
    "Semantic metadata:",
    `- category: ${tool.category || "none"}`,
    `- keywords: ${tool.keywords?.length ? tool.keywords.join(", ") : "none"}`
  ].join("\n");
}

export class ToolRegistry {
  constructor({ logger, usageStore = new ToolUsageStore() } = {}) {
    this.logger = logger;
    this.tools = new Map();
    this.skillRegistry = new SkillRegistry();
    this.usageStore = usageStore;
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
      description: tool.description,
      input: tool.input,
      output: tool.output,
      configSchema: tool.configSchema || {},
      category: tool.category,
      keywords: tool.keywords || [],
      skillHints: tool.skillHints || []
    }));
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
    const counts = await this.usageStore.counts(chatId);
    return this.list()
      .map((tool) => ({ name: tool.name, count: counts[tool.name] || 0 }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async run({ name, request, chatId = null }) {
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
    await writeFile(requestFile, `${JSON.stringify(enrichedRequest, null, 2)}\n`, "utf8");
    const result = await runProcess("node", [tool.entry, "run", "--request-file", requestFile], {
      cwd: tool.dir,
      env: toolEnv()
    });
    await unlink(requestFile).catch(() => {});
    await rmdir(tmpDir).catch(() => {});
    if (chatId != null) {
      await rmdir(path.dirname(tmpDir)).catch(() => {});
      await rmdir(path.dirname(path.dirname(tmpDir))).catch(() => {});
    }
    try {
      const parsed = JSON.parse(result.stdout || result.stderr);
      const normalized = normalizeToolResult(name, parsed);
      if (normalized.ok === false) {
        this.logger?.log("tools", `${name} -> ${normalized.status || "error"}: ${normalized.error || "unknown error"}`);
      } else {
        this.logger?.log("tools", `${name} -> ok`);
      }
      return normalized;
    } catch {
      return normalizeToolResult(name, {
        ok: false,
        error: `Invalid tool response for ${name}`,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
  }
}
