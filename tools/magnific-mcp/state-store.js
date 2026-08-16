import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readState(stateDir) {
  try {
    const parsed = JSON.parse(await readFile(path.join(stateDir, "preparations.json"), "utf8"));
    return { preparations: parsed.preparations || {}, jobs: parsed.jobs || {} };
  } catch (error) {
    if (error?.code === "ENOENT") return { preparations: {}, jobs: {} };
    throw error;
  }
}

export async function writeState(stateDir, state) {
  await mkdir(stateDir, { recursive: true });
  const target = path.join(stateDir, "preparations.json");
  const temporary = path.join(stateDir, `.preparations-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

export function pruneState(state, now = Date.now()) {
  state.preparations ||= {};
  state.jobs ||= {};
  for (const [id, item] of Object.entries(state.preparations)) {
    if (Date.parse(item.expiresAt) <= now || item.usedAt) delete state.preparations[id];
  }
  for (const [id, job] of Object.entries(state.jobs)) {
    if (Date.parse(job.expiresAt) <= now) delete state.jobs[id];
  }
  return state;
}

export const prunePreparations = pruneState;
