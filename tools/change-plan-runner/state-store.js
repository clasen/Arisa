import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(lockFile) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOCK_WAIT_MS) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return async () => {
        await handle.close().catch(() => {});
        await rm(lockFile, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const details = await stat(lockFile).catch(() => null);
      if (details && Date.now() - details.mtimeMs > LOCK_STALE_MS) {
        await rm(lockFile, { force: true }).catch(() => {});
        continue;
      }
      await sleep(25);
    }
  }
  throw new Error("Change plan state is busy; retry shortly");
}

export class ChangePlanStore {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.stateFile = path.join(stateDir, "active-plan.json");
    this.lockFile = path.join(stateDir, "active-plan.lock");
  }

  async read() {
    try {
      return JSON.parse(await readFile(this.stateFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async replace(plan) {
    return this.mutate(() => plan);
  }

  async mutate(operation) {
    await mkdir(this.stateDir, { recursive: true });
    const release = await acquireLock(this.lockFile);
    try {
      const current = await this.read();
      const next = await operation(current);
      if (!next) return current;
      const temporary = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.stateFile);
      return next;
    } finally {
      await release();
    }
  }
}
