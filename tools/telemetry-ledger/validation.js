const sensitiveKey = /token|secret|password|cookie|authorization|credential|body|content|email|phone|address/i;
const metricPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function cleanText(value, max, name) {
  const text = String(value || "").trim();
  if (!text || text.length > max) throw new Error(`${name} must contain 1-${max} characters`);
  return text;
}

export function validateMetricName(value) {
  const metric = cleanText(value, 120, "metric");
  if (!metricPattern.test(metric)) throw new Error("metric must be lowercase dot-delimited text");
  return metric;
}

export function validateDimensions(value = {}, allowed = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("dimensions must be an object");
  const entries = Object.entries(value);
  if (entries.length > 12) throw new Error("dimensions may contain at most 12 entries");
  const result = {};
  for (const [rawKey, rawValue] of entries) {
    const key = cleanText(rawKey, 40, "dimension key");
    if (!/^[a-z][a-z0-9_-]*$/.test(key) || sensitiveKey.test(key)) throw new Error(`unsafe dimension key: ${key}`);
    if (allowed && !allowed.includes(key)) throw new Error(`dimension is not declared for this metric: ${key}`);
    if (!["string", "number", "boolean"].includes(typeof rawValue)) throw new Error(`dimension ${key} must be scalar`);
    const scalar = String(rawValue);
    if (scalar.length > 120 || /\b(?:bearer|sk-[a-z0-9_-]{10,})\b/i.test(scalar)) throw new Error(`unsafe dimension value for ${key}`);
    result[key] = rawValue;
  }
  return result;
}

export function validateDefinition(input) {
  const metric = validateMetricName(input.metric);
  const kind = String(input.kind || "gauge").toLowerCase();
  const direction = String(input.direction || "neutral").toLowerCase();
  if (!["counter", "gauge", "duration", "event"].includes(kind)) throw new Error("kind must be counter, gauge, duration, or event");
  if (!["lower", "higher", "neutral"].includes(direction)) throw new Error("direction must be lower, higher, or neutral");
  const dimensions = Array.isArray(input.dimensions) ? input.dimensions.map((key) => validateDimensions({ [key]: "x" }) && key) : [];
  return { metric, kind, unit: String(input.unit || "").slice(0, 30), direction, description: String(input.description || "").slice(0, 300), dimensions };
}

export function validateRecord(input, definition) {
  const metric = validateMetricName(input.metric);
  const kind = String(input.kind || definition?.kind || "gauge").toLowerCase();
  const value = input.value === undefined && kind === "event" ? 1 : Number(input.value);
  if (!["counter", "gauge", "duration", "event"].includes(kind)) throw new Error(`invalid kind for ${metric}`);
  if (!Number.isFinite(value)) throw new Error(`value must be finite for ${metric}`);
  const timestamp = input.timestamp ? new Date(input.timestamp) : new Date();
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`invalid timestamp for ${metric}`);
  return {
    metric,
    kind,
    value,
    unit: String(input.unit || definition?.unit || "").slice(0, 30),
    timestamp: timestamp.toISOString(),
    source: String(input.source || "manual").slice(0, 80),
    traceId: String(input.traceId || "").slice(0, 100),
    dimensions: validateDimensions(input.dimensions || {}, definition?.dimensions || null)
  };
}
