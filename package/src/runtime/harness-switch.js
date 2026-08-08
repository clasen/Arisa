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
  switchRuntime
}) {
  if (!supportedHarnesses.has(targetRuntime)) {
    throw new Error(`Unsupported agent runtime: ${targetRuntime}`);
  }
  if (config.agent?.runtime === targetRuntime) {
    return { changed: false, runtime: targetRuntime };
  }

  const original = structuredClone(config);
  const candidate = structuredClone(config);
  candidate.agent = { ...candidate.agent, runtime: targetRuntime };
  const prepared = await prepareRuntime(candidate);
  await validateRuntime(prepared);
  const handoffs = await prepareContinuity();
  await saveConfig(prepared);
  try {
    await switchRuntime(prepared, {
      handoffs,
      onActivate: (candidate) => replaceLiveConfig(config, candidate)
    });
  } catch (error) {
    replaceLiveConfig(config, original);
    await saveConfig(original);
    throw error;
  }
  return { changed: true, runtime: targetRuntime };
}
