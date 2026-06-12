import { fileURLToPath } from "node:url";
import { arisaHomeDir, chatsDir, stateDir, toolStateDir, toolsDir } from "../../runtime/paths.js";

export const arisaInstallDir = fileURLToPath(new URL("../../..", import.meta.url));

export function buildAgentRuntimeContext() {
  return [
    `arisaHomeDir: ${arisaHomeDir}`,
    `arisaInstallDir: ${arisaInstallDir}`,
    `userToolsDir: ${toolsDir}`,
    `toolStateDir: ${toolStateDir}`,
    `chatsDir: ${chatsDir}`,
    `stateDir: ${stateDir}`
  ].join("\n");
}
