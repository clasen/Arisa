export const MODEL_SPEEDS = Object.freeze([1, 1.5]);

export function normalizeModelSpeed(speed) {
  const value = Number(speed);
  if (!MODEL_SPEEDS.includes(value)) {
    throw new Error(`Invalid model speed: ${speed}`);
  }
  return value;
}

export function modelSupportsSpeed(model) {
  return model?.provider === "openai-codex"
    && model.api === "openai-codex-responses"
    && typeof model.id === "string"
    && (
      model.id === "gpt-5.4"
      || model.id === "gpt-5.5"
      || model.id === "gpt-5.6"
      || model.id.startsWith("gpt-5.6-")
    );
}

export function clampModelSpeed(model, speed) {
  const normalized = normalizeModelSpeed(speed);
  return normalized === 1.5 && !modelSupportsSpeed(model) ? 1 : normalized;
}

export function speedToServiceTier(speed) {
  return normalizeModelSpeed(speed) === 1.5 ? "priority" : "default";
}
