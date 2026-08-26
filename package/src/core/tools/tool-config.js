import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getToolConfigPath, getChatToolConfigPath } from "../../platform/paths.js";

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

export async function loadToolConfig(toolName, defaults = {}, chatId = null) {
  const globalPath = getToolConfigPath(toolName);
  const globalStored = await readConfigModule(globalPath, {});
  const merged = { ...defaults, ...globalStored };

  if (chatId == null) return merged;

  const chatPath = getChatToolConfigPath(chatId, toolName);
  const chatStored = await readConfigModule(chatPath, {});
  return { ...merged, ...chatStored };
}

export async function writeToolConfig(toolName, config, chatId = null) {
  const configPath = chatId != null
    ? getChatToolConfigPath(chatId, toolName)
    : getToolConfigPath(toolName);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, serializeConfigModule(config), "utf8");
  return configPath;
}
