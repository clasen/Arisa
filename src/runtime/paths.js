import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const arisaHomeDir = path.join(os.homedir(), ".arisa");
export const stateDir = path.join(arisaHomeDir, "state");
export const configFile = path.join(stateDir, "config.json");
export const servicePidFile = path.join(stateDir, "arisa.pid");
export const serviceLogFile = path.join(stateDir, "arisa.log");
export const tasksFile = path.join(stateDir, "tasks.json");
export const toolsDir = path.join(arisaHomeDir, "tools");
export const chatsDir = path.join(arisaHomeDir, "chats");

export function getChatDir(chatId) {
  return path.join(chatsDir, String(chatId));
}

export function getChatArtifactsDir(chatId) {
  return path.join(getChatDir(chatId), "artifacts");
}

export function getChatArtifactsIndexFile(chatId) {
  return path.join(getChatDir(chatId), "state", "artifacts.json");
}

export function getChatPiSessionsDir(chatId) {
  return path.join(getChatDir(chatId), "state", "pi-sessions");
}

export function getToolDir(toolName) {
  return path.join(toolsDir, toolName);
}

export function getToolConfigPath(toolName) {
  return path.join(getToolDir(toolName), "config.js");
}

export function getChatToolConfigPath(chatId, toolName) {
  return path.join(getChatDir(chatId), "tools", toolName, "config.js");
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

export function getChatToolTmpDir(chatId, toolName) {
  return path.join(getChatDir(chatId), "tools", toolName, "tmp");
}

export async function ensureArisaHome() {
  await mkdir(stateDir, { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  await mkdir(chatsDir, { recursive: true });
}

