import { fileURLToPath } from "node:url";
import { arisaHomeDir, arisaPackageDir, chatsDir, stateDir, toolStateDir, toolsDir } from "../../runtime/paths.js";

export const arisaInstallDir = fileURLToPath(new URL("../../..", import.meta.url));

function formatCoreTools(coreTools = []) {
  const enabled = coreTools
    .filter((tool) => tool.enabled)
    .map((tool) => tool.name);
  return enabled.length ? enabled.join(", ") : "(none)";
}

export function buildAgentRuntimeContext({ workspaceDir = arisaHomeDir, coreTools = [] } = {}) {
  return [
    `workspaceDir: ${workspaceDir}`,
    `arisaHomeDir: ${arisaHomeDir}`,
    `arisaPackageDir: ${arisaPackageDir}`,
    `arisaInstallDir: ${arisaInstallDir}`,
    `userToolsDir: ${toolsDir}`,
    `toolStateDir: ${toolStateDir}`,
    `chatsDir: ${chatsDir}`,
    `stateDir: ${stateDir}`,
    `enabledCoreTools: ${formatCoreTools(coreTools)}`,
    "Guidance: create or edit user tools under userToolsDir. Treat arisaPackageDir/arisaInstallDir as Arisa core and modify it only when the user explicitly asks for core changes."
  ].join("\n");
}
