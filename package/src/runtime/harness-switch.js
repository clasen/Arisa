import crypto from "node:crypto";

const supportedHarnesses = new Set(["pi", "prime"]);

export function replaceLiveConfig(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
  return target;
}

export async function activateHarness({
  config,
  targetRuntime,
  prepareRuntime,
  validateRuntime,
  prepareContinuity,
  saveConfig,
  switchRuntime,
  traceTransition
}) {
  if (!supportedHarnesses.has(targetRuntime)) {
    throw new Error(`Unsupported agent runtime: ${targetRuntime}`);
  }
  if (config.agent?.runtime === targetRuntime) {
    return { changed: false, runtime: targetRuntime };
  }
  if (typeof traceTransition !== "function") {
    throw new Error("Harness activation requires transition tracing");
  }

  const original = structuredClone(config);
  const fromRuntime = original.agent?.runtime;
  const transitionId = crypto.randomUUID();
  const trace = (phase) => traceTransition({
    transitionId,
    phase,
    fromRuntime,
    toRuntime: targetRuntime
  });
  await trace("started");
  const candidate = structuredClone(config);
  candidate.agent = { ...candidate.agent, runtime: targetRuntime };
  let persisted = false;
  try {
    const prepared = await prepareRuntime(candidate);
    await validateRuntime(prepared);
    const handoffs = await prepareContinuity();
    await saveConfig(prepared);
    persisted = true;
    await switchRuntime(prepared, {
      handoffs,
      onActivate: (candidate) => replaceLiveConfig(config, candidate)
    });
    await trace("completed");
  } catch (error) {
    if (persisted) {
      replaceLiveConfig(config, original);
      await saveConfig(original);
    }
    await trace(persisted ? "rolled_back" : "failed").catch(() => {});
    throw error;
  }
  return { changed: true, runtime: targetRuntime, transitionId };
}
