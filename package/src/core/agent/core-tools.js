import os from "node:os";
import path from "node:path";
import { arisaHomeDir } from "../../platform/paths.js";

const defaultShellTimeoutMs = 60_000;

export const coreCodingToolCatalog = [
  {
    name: "read",
    source: "pi-builtin",
    description: "Read files and supported images from the active workspace.",
    defaultEnabled: true
  },
  {
    name: "bash",
    source: "pi-builtin",
    description: "Run bash-compatible commands from the active workspace.",
    defaultEnabled: true
  },
  {
    name: "edit",
    source: "pi-builtin",
    description: "Patch existing files in the active workspace.",
    defaultEnabled: true
  },
  {
    name: "write",
    source: "pi-builtin",
    description: "Create or overwrite files in the active workspace.",
    defaultEnabled: true
  },
  {
    name: "grep",
    source: "pi-builtin",
    description: "Search file contents from the active workspace.",
    defaultEnabled: false
  },
  {
    name: "find",
    source: "pi-builtin",
    description: "Find files from the active workspace.",
    defaultEnabled: false
  },
  {
    name: "ls",
    source: "pi-builtin",
    description: "List directories from the active workspace.",
    defaultEnabled: false
  }
];

function unique(values) {
  return [...new Set(values)];
}

function expandHomeDir(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function normalizeToolList(value) {
  if (Array.isArray(value)) {
    const tools = value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    return tools.length ? unique(tools) : undefined;
  }

  if (typeof value === "string") {
    const tools = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return tools.length ? unique(tools) : undefined;
  }

  return undefined;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

export function resolveWorkspaceDir(value, defaultWorkspaceDir = arisaHomeDir) {
  const raw = typeof value === "string" && value.trim()
    ? value.trim()
    : defaultWorkspaceDir;
  return path.resolve(expandHomeDir(raw));
}

function buildAllowedTools({ configuredTools, customToolNames }) {
  if (!configuredTools) return undefined;
  return unique([...configuredTools, ...customToolNames]);
}

export function getCoreCodingTools({ tools, excludeTools } = {}) {
  const allowed = tools ? new Set(tools) : null;
  const excluded = new Set(excludeTools || []);

  return coreCodingToolCatalog.map((tool) => {
    const enabled = allowed
      ? allowed.has(tool.name)
      : tool.defaultEnabled;
    return {
      ...tool,
      enabled: enabled && !excluded.has(tool.name)
    };
  });
}

export function buildPiToolPolicy({
  config,
  customToolNames = [],
  defaultWorkspaceDir = arisaHomeDir
} = {}) {
  const configuredTools = normalizeToolList(config?.pi?.tools);
  const excludeTools = normalizeToolList(config?.pi?.excludeTools);
  const tools = buildAllowedTools({ configuredTools, customToolNames });
  const workspaceDir = resolveWorkspaceDir(config?.pi?.workspaceDir, defaultWorkspaceDir);

  return {
    workspaceDir,
    tools,
    excludeTools,
    coreTools: getCoreCodingTools({ tools, excludeTools }),
    shell: {
      shellPath: typeof config?.pi?.shellPath === "string" && config.pi.shellPath.trim()
        ? config.pi.shellPath.trim()
        : "",
      timeoutMs: normalizePositiveInteger(config?.pi?.shellTimeoutMs, defaultShellTimeoutMs)
    }
  };
}
