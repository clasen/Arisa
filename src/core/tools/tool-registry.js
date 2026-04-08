import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getToolConfigPath, getToolTmpDir, toolsDir as userToolsRoot } from "../../runtime/paths.js";
import { loadToolConfig, parseConfigModule, writeToolConfig } from "./tool-config.js";
import { normalizeToolResult } from "./tool-result.js";

const bundledToolsRoot = fileURLToPath(new URL("../../../tools", import.meta.url));
const toolRoots = [
  { root: userToolsRoot, kind: "user" },
  { root: bundledToolsRoot, kind: "bundled" }
];

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

export class ToolRegistry {
  constructor({ logger } = {}) {
    this.logger = logger;
    this.tools = new Map();
  }

  async load() {
    this.tools.clear();

    for (const { root, kind } of toolRoots) {
      let entries = [];
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        this.logger?.log("tools", `${kind} tools directory not found: ${root}`);
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const toolDir = path.join(root, entry.name);
        const manifestPath = path.join(toolDir, "tool.manifest.json");
        const configPath = path.join(toolDir, "config.js");
        try {
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          if (this.tools.has(manifest.name)) continue;
          const configSource = await readFile(configPath, "utf8");
          const defaults = parseConfigModule(configSource);
          const config = await loadToolConfig(manifest.name, defaults);
          this.tools.set(manifest.name, {
            ...manifest,
            dir: toolDir,
            entry: path.join(toolDir, manifest.entry || "index.js"),
            localConfigPath: configPath,
            configPath: getToolConfigPath(manifest.name),
            defaults,
            config,
            sourceKind: kind
          });
        } catch {
          // ignore invalid tool dirs in v1
        }
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
      configSchema: tool.configSchema || {}
    }));
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  async help(name) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    const result = await runProcess("node", [tool.entry, "--help"], { cwd: tool.dir, env: process.env });
    return result.stdout || result.stderr;
  }

  async setConfig(name, field, value) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    const config = { ...(tool.config || {}) };
    config[field] = value;
    const configPath = await writeToolConfig(name, config);
    tool.config = config;
    tool.configPath = configPath;
    return { ok: true, tool: name, field, configPath };
  }

  async run({ name, request }) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    this.logger?.log("tools", `running ${name}`);
    const tmpDir = getToolTmpDir(name);
    await mkdir(tmpDir, { recursive: true });
    const requestFile = path.join(tmpDir, `.request-${Date.now()}.json`);
    await writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");
    const result = await runProcess("node", [tool.entry, "run", "--request-file", requestFile], {
      cwd: tool.dir,
      env: process.env
    });
    await unlink(requestFile).catch(() => {});
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
