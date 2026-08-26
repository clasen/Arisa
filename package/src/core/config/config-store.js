import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configFile } from "../../platform/paths.js";
import { applyConfigDefaults } from "./config-defaults.js";

export function prepareConfigForSave(config) {
  return applyConfigDefaults(config);
}

export async function loadConfig() {
  const raw = await readFile(configFile, "utf8");
  return applyConfigDefaults(JSON.parse(raw));
}

export async function saveConfig(config) {
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, `${JSON.stringify(prepareConfigForSave(config), null, 2)}\n`, "utf8");
}

export async function updateConfig(mutator) {
  const config = await loadConfig();
  await mutator(config);
  await saveConfig(config);
  return config;
}
