import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

const REQUIREMENT_FIELDS = Object.freeze(["filesystem", "processes", "network", "privileges"]);
const MAX_TEXT_CHARS = 512;

function text(value, limit = MAX_TEXT_CHARS) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function strings(value, limit = 256) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim()).slice(0, limit).map((item) => text(item));
}

function safeRequirements(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(REQUIREMENT_FIELDS
    .map((field) => [field, strings(value[field])])
    .filter(([, entries]) => entries.length));
}

function safeHealth(daemon) {
  if (!daemon || typeof daemon !== "object") return null;
  const runtime = daemon.runtime || {};
  return {
    scope: daemon.scope === "chat" ? "chat" : "global",
    autoStart: Boolean(daemon.autoStart),
    state: typeof runtime.state === "string" ? runtime.state : "unknown",
    alive: Boolean(runtime.alive),
    disposition: typeof runtime.disposition === "string" ? runtime.disposition : null
  };
}

export function buildSafeToolDescriptor(tool, { version = null, digest = null } = {}) {
  if (!tool || typeof tool.name !== "string" || !tool.name.trim()) throw new Error("Tool descriptor requires a name");
  return {
    name: text(tool.name, 128),
    version: text(version || tool.version, 128) || null,
    digest: text(digest || tool.digest, 128) || null,
    description: text(tool.description),
    category: text(tool.category, 128) || null,
    keywords: strings(tool.keywords),
    input: strings(tool.input),
    output: strings(tool.output),
    configFields: Object.keys(tool.configSchema || {}).sort().slice(0, 256).map((field) => text(field, 128)),
    requirements: safeRequirements(tool.requirements),
    available: tool.available !== false,
    health: safeHealth(tool.daemon)
  };
}

export function buildSafeToolCatalog(tools, metadata = {}) {
  if (!Array.isArray(tools)) throw new Error("Tool catalog input must be an array");
  return tools.map((tool) => buildSafeToolDescriptor(tool, metadata[tool.name] || {}))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function buildSafeSlaveProfile(profile, { tools = [] } = {}) {
  if (!profile || typeof profile !== "object") throw new Error("Slave profile is required");
  return {
    slaveId: text(String(profile.slaveId || ""), 128),
    name: text(String(profile.name || ""), 128),
    description: text(String(profile.description || "")),
    hostname: text(String(profile.hostname || ""), 255),
    platform: text(String(profile.platform || ""), 128),
    arch: text(String(profile.arch || ""), 128),
    arisaVersion: text(String(profile.arisaVersion || ""), 128),
    masterEndpoint: text(String(profile.masterEndpoint || ""), 512),
    privilege: {
      user: text(String(profile.privilege?.user || ""), 128),
      root: Boolean(profile.privilege?.root),
      scope: text(String(profile.privilege?.scope || "restricted"), 128)
    },
    roots: strings(profile.roots),
    capabilities: strings(profile.capabilities),
    tools: buildSafeToolCatalog(tools)
  };
}

async function collectPackageEntries(root, directory = "") {
  const entries = [];
  const names = await readdir(path.join(root, directory), { withFileTypes: true });
  for (const entry of names.sort((left, right) => left.name.localeCompare(right.name))) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const relative = path.posix.join(directory.split(path.sep).join("/"), entry.name);
    if (relative === "config.js") continue;
    const absolute = path.join(root, relative);
    const stats = await lstat(absolute);
    if (stats.isDirectory()) {
      entries.push(...await collectPackageEntries(root, relative));
    } else if (stats.isSymbolicLink()) {
      entries.push({ path: relative, mode: stats.mode & 0o777, content: Buffer.from(await readlink(absolute), "utf8") });
    } else if (stats.isFile()) {
      entries.push({ path: relative, mode: stats.mode & 0o777, content: await readFile(absolute) });
    }
  }
  return entries;
}

export async function digestToolPackage(root) {
  const hash = createHash("sha256");
  for (const entry of await collectPackageEntries(root)) {
    const name = Buffer.from(entry.path, "utf8");
    const header = Buffer.alloc(12);
    header.writeUInt32BE(name.length, 0);
    header.writeUInt32BE(entry.mode, 4);
    header.writeUInt32BE(entry.content.length, 8);
    hash.update(header).update(name).update(entry.content);
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function readToolPackageVersion(root) {
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
