import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const cliRoot = path.resolve("cli");

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

function parseConfigModule(source) {
  const normalized = source.replace(/^export\s+default/, "return");
  return new Function(normalized)();
}

function serializeConfigModule(config) {
  const lines = Object.entries(config).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`);
  return `export default {\n${lines.join(",\n")}\n};\n`;
}

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  async load() {
    this.tools.clear();
    let entries = [];
    try {
      entries = await readdir(cliRoot, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const toolDir = path.join(cliRoot, entry.name);
      const manifestPath = path.join(toolDir, "tool.manifest.json");
      const configPath = path.join(toolDir, "config.js");
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const configSource = await readFile(configPath, "utf8");
        const config = parseConfigModule(configSource);
        this.tools.set(manifest.name, {
          ...manifest,
          dir: toolDir,
          entry: path.join(toolDir, manifest.entry || "index.js"),
          configPath,
          config
        });
      } catch {
        // ignore invalid tool dirs in v1
      }
    }
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
    await writeFile(tool.configPath, serializeConfigModule(config), "utf8");
    tool.config = config;
    return { ok: true, tool: name, field, configPath: tool.configPath };
  }

  async run({ name, request }) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    const requestFile = path.join(tool.dir, `.request-${Date.now()}.json`);
    await writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");
    const result = await runProcess("node", [tool.entry, "run", "--request-file", requestFile], {
      cwd: tool.dir,
      env: process.env
    });
    await unlink(requestFile).catch(() => {});
    try {
      const parsed = JSON.parse(result.stdout || result.stderr);
      return parsed;
    } catch {
      return {
        ok: false,
        error: `Invalid tool response for ${name}`,
        stdout: result.stdout,
        stderr: result.stderr
      };
    }
  }
}
