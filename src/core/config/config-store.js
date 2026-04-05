import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configFile } from "../../runtime/bootstrap.js";

export async function loadConfig() {
  const raw = await readFile(configFile, "utf8");
  return JSON.parse(raw);
}

export async function saveConfig(config) {
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function updateConfig(mutator) {
  const config = await loadConfig();
  await mutator(config);
  await saveConfig(config);
  return config;
}
