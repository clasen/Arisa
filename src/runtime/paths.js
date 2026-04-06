import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const arisaHomeDir = path.join(os.homedir(), ".arisa");
export const stateDir = path.join(arisaHomeDir, "state");
export const configFile = path.join(stateDir, "config.json");
export const servicePidFile = path.join(stateDir, "arisa.pid");
export const serviceLogFile = path.join(stateDir, "arisa.log");
export const artifactsDir = path.join(arisaHomeDir, "artifacts");
export const artifactsIndexFile = path.join(stateDir, "artifacts.json");
export const piAgentDir = path.join(stateDir, "pi-agent");
export const chatsDir = path.join(arisaHomeDir, "chats");
export const toolsDir = path.join(arisaHomeDir, "tools");
export const tmpDir = path.join(arisaHomeDir, "tmp");

export function getChatDir(chatId) {
  return path.join(chatsDir, String(chatId));
}

export function getToolDir(toolName) {
  return path.join(toolsDir, toolName);
}

export function getToolConfigPath(toolName) {
  return path.join(getToolDir(toolName), "config.js");
}

export function getToolRuntimeDir(toolName) {
  return getToolDir(toolName);
}

export function getToolOutDir(toolName) {
  return path.join(getToolRuntimeDir(toolName), "out");
}

export function getToolTmpDir(toolName) {
  return path.join(getToolRuntimeDir(toolName), "tmp");
}

export async function ensureArisaHome() {
  await mkdir(stateDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(piAgentDir, { recursive: true });
  await mkdir(chatsDir, { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });
}

