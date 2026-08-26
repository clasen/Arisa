import { spawn } from "node:child_process";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? Math.min(parsed, maximum) : fallback;
}

export function createServiceSupervisor({
  command,
  args,
  env = process.env,
  restartLimit = 3,
  restartBackoffMs = 2_000,
  restartBackoffMaxMs = 60_000,
  stableRuntimeMs = 60_000,
  logger,
  onUnexpectedExit = null,
  spawnProcess = spawn,
  wait = sleep
}) {
  const maximumRestarts = boundedInteger(restartLimit, 3, 0, 10);
  const initialBackoffMs = boundedInteger(restartBackoffMs, 2_000, 1, 60_000);
  const maximumBackoffMs = boundedInteger(restartBackoffMaxMs, 60_000, initialBackoffMs, 5 * 60_000);
  const stableAfterMs = boundedInteger(stableRuntimeMs, 60_000, 1_000, 60 * 60_000);
  let child = null;
  let stopping = false;
  let wakeBackoff = null;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  async function run() {
    let consecutiveFailures = 0;
    while (!stopping) {
      const startedAt = Date.now();
      child = spawnProcess(command, args, {
        stdio: "inherit",
        env: { ...env, ARISA_SUPERVISOR_PID: String(process.pid) }
      });
      logger?.log("service", `worker started (pid ${child.pid})`);

      const outcome = await new Promise((resolve) => {
        child.once("error", (error) => resolve({ error }));
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      child = null;
      if (stopping) break;

      const runtimeMs = Date.now() - startedAt;
      if (runtimeMs >= stableAfterMs) consecutiveFailures = 0;
      consecutiveFailures += 1;
      const detail = outcome.error
        ? errorMessage(outcome.error)
        : `code=${outcome.code ?? "null"} signal=${outcome.signal || "none"}`;
      logger?.error("service", `worker exited unexpectedly (${detail})`);
      if (consecutiveFailures > maximumRestarts) {
        logger?.error("service", `worker restart limit reached after ${consecutiveFailures} consecutive exits`);
        break;
      }

      const delay = Math.min(maximumBackoffMs, initialBackoffMs * (2 ** (consecutiveFailures - 1)));
      try {
        await onUnexpectedExit?.({
          occurredAt: new Date().toISOString(),
          runtimeMs,
          restartDelayMs: delay,
          consecutiveFailures,
          code: outcome.code ?? null,
          signal: outcome.signal || null,
          detail
        });
      } catch (error) {
        logger?.error("service", `worker recovery report failed: ${errorMessage(error)}`);
      }
      logger?.log("service", `restarting worker in ${delay}ms`);
      await Promise.race([
        wait(delay),
        new Promise((resolve) => { wakeBackoff = resolve; })
      ]);
      wakeBackoff = null;
    }
    resolveDone();
  }

  return {
    async start() {
      run().catch((error) => {
        logger?.error("service", `supervisor failed: ${errorMessage(error)}`);
        resolveDone();
      });
      return done;
    },
    async stop() {
      stopping = true;
      wakeBackoff?.();
      if (child) {
        const activeChild = child;
        const exited = new Promise((resolve) => activeChild.once("exit", resolve));
        activeChild.kill("SIGTERM");
        await exited;
      }
      resolveDone();
    }
  };
}
