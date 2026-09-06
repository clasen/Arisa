export const MODEL_SPEEDS = Object.freeze([1, 1.5, 2]);

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
      || model.id === "gpt-6-astra"
    );
}

export function modelFastSpeed(modelId) {
  return modelId === "gpt-6-astra" ? 2 : 1.5;
}

export function listModelSpeeds(model) {
  return modelSupportsSpeed(model) ? [1, modelFastSpeed(model.id)] : [1];
}

export function clampModelSpeed(model, speed) {
  const normalized = normalizeModelSpeed(speed);
  return normalized > 1 && modelSupportsSpeed(model) ? modelFastSpeed(model.id) : 1;
}

export function speedToServiceTier(speed) {
  return normalizeModelSpeed(speed) > 1 ? "priority" : "default";
}

export function createModelSpeedController(streamFn, initialSpeed) {
  if (typeof streamFn !== "function") throw new Error("Pi stream function is unavailable");
  let speed = normalizeModelSpeed(initialSpeed);
  return {
    get speed() {
      return speed;
    },
    setSpeed(nextSpeed) {
      speed = normalizeModelSpeed(nextSpeed);
    },
    streamFn(model, context, options) {
      if (!modelSupportsSpeed(model)) return streamFn(model, context, options);
      const serviceTier = speedToServiceTier(speed);
      const onPayload = options?.onPayload;
      return streamFn(model, context, {
        ...options,
        serviceTier,
        async onPayload(payload, requestModel) {
          const replacement = await onPayload?.(payload, requestModel);
          const effectivePayload = replacement === undefined ? payload : replacement;
          if (!effectivePayload || typeof effectivePayload !== "object" || Array.isArray(effectivePayload)) {
            throw new Error("Pi provider payload is not an object");
          }
          return { ...effectivePayload, service_tier: serviceTier };
        }
      });
    }
  };
}
