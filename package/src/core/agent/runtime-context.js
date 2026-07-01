import path from "node:path";
import { fileURLToPath } from "node:url";
import { arisaHomeDir, arisaPackageDir, chatsDir, stateDir, toolStateDir, toolsDir } from "../../runtime/paths.js";

export const arisaInstallDir = fileURLToPath(new URL("../../..", import.meta.url));
export const arisaAgentsFile = path.join(arisaPackageDir, "AGENTS.md");

export function appendArisaAgentsFile(current, content, agentsFilePath = arisaAgentsFile) {
  return {
    ...current,
    agentsFiles: [
      ...(current.agentsFiles || []).filter((file) => path.resolve(file.path) !== path.resolve(agentsFilePath)),
      { path: agentsFilePath, content }
    ]
  };
}

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
    `arisaAgentsFile: ${arisaAgentsFile}`,
    `enabledCoreTools: ${formatCoreTools(coreTools)}`,
    "Guidance: create or edit user tools under userToolsDir. Treat arisaPackageDir/arisaInstallDir as Arisa core and modify it only when the user explicitly asks for core changes."
  ].join("\n");
}
