import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configFile } from "../../runtime/paths.js";
import { applyConfigDefaults } from "./config-defaults.js";

const transientPrimeConfigKeys = [
  "commandArgs",
  "managedRuntime",
  "runtimeDir",
  "kernelVenvDir"
];

export function prepareConfigForSave(config) {
  const prepared = applyConfigDefaults(config);
  const prime = { ...prepared.prime };
  if (prime.managedRuntime === true) prime.command = "";
  for (const key of transientPrimeConfigKeys) delete prime[key];
  return { ...prepared, prime };
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
