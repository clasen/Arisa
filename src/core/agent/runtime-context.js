import { fileURLToPath } from "node:url";
import { arisaHomeDir, artifactsDir, stateDir, toolsDir } from "../../runtime/paths.js";

export const arisaInstallDir = fileURLToPath(new URL("../../..", import.meta.url));
export const bundledToolsDir = fileURLToPath(new URL("../../../tools", import.meta.url));

export function buildAgentRuntimeContext() {
  return [
    `arisaHomeDir: ${arisaHomeDir}`,
    `arisaInstallDir: ${arisaInstallDir}`,
    `bundledToolsDir: ${bundledToolsDir}`,
    `userToolsDir: ${toolsDir}`,
    `artifactsDir: ${artifactsDir}`,
    `stateDir: ${stateDir}`
  ].join("\n");
}
