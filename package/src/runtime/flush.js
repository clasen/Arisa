import { rm } from "node:fs/promises";
import { arisaHomeDir } from "../platform/paths.js";

export async function flushArisaHome() {
  await rm(arisaHomeDir, { recursive: true, force: true });
  return { ok: true, path: arisaHomeDir };
}
