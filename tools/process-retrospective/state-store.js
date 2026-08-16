import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STATE = {
  enabled: false,
  passCount: 0,
  startedAt: null,
  lastRunAt: null,
  intervalSeconds: null,
  passesPerFocus: null
};

export async function readState(stateDir) {
  try {
    const raw = await readFile(path.join(stateDir, "state.json"), "utf8");
    return { ...EMPTY_STATE, ...JSON.parse(raw) };
  } catch (error) {
    if (error?.code === "ENOENT") return { ...EMPTY_STATE };
    throw error;
  }
}

export async function writeState(stateDir, state) {
  await mkdir(stateDir, { recursive: true });
  const target = path.join(stateDir, "state.json");
  const temporary = path.join(stateDir, `.state-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  return state;
}
