import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getToolConfigPath } from "../../runtime/paths.js";

export function parseConfigModule(source) {
  const normalized = source.replace(/^export\s+default/, "return");
  return new Function(normalized)();
}

export function serializeConfigModule(config) {
  const lines = Object.entries(config).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`);
  return `export default {\n${lines.join(",\n")}\n};\n`;
}

export async function readConfigModule(filePath, fallback = {}) {
  try {
    const source = await readFile(filePath, "utf8");
    return parseConfigModule(source);
  } catch {
    return fallback;
  }
}

export async function loadToolConfig(toolName, defaults = {}) {
  const configPath = getToolConfigPath(toolName);
  const stored = await readConfigModule(configPath, {});
  return { ...defaults, ...stored };
}

export async function writeToolConfig(toolName, config) {
  const configPath = getToolConfigPath(toolName);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, serializeConfigModule(config), "utf8");
  return configPath;
}
