const actionableText = /(?:\b(?:please|can you|could you|need you|help|review|check|send|tell me|let me know|pod[eé]s|puedes|pueden|necesito|necesitamos|ayud[áa]|revis[áa]|cheque[áa]|mand[áa]|envi[áa]|pasame|pasáme|decime|dime|avisame|avísame|confirm[áa]|respond[eé]|contest[áa]|hac[eé]|haz|mir[áa])\b)/iu;
const actionableTypes = new Set(["audio", "ptt", "image", "video", "document", "location"]);

export function wakeGateResourceIds(value) {
  return new Set(String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 100));
}

export function normalizeWakeGateMode(value) {
  const mode = String(value || "off").trim().toLowerCase();
  return ["off", "shadow", "enforce"].includes(mode) ? mode : "off";
}

function invokesName(text, names) {
  const normalized = String(text || "").toLowerCase();
  return names.some((name) => {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, "iu").test(normalized);
  });
}

export function classifyIncomingWake(items, { bypassNames = ["peter"] } = {}) {
  for (const item of items || []) {
    const message = item.message || {};
    const text = String(item.transcript || message.body || "").trim();
    if (invokesName(text, bypassNames)) return { wake: true, reason: "explicit-invocation" };
    if (text.includes("?") || text.includes("¿")) return { wake: true, reason: "question" };
    if (actionableText.test(text)) return { wake: true, reason: "actionable-text" };
    if (item.artifact || actionableTypes.has(String(message.type || "").toLowerCase())) {
      return { wake: true, reason: "actionable-media" };
    }
  }
  return { wake: false, reason: "passive-chatter" };
}

export function updateWakeGateMetrics(current, { mode, decision, messageCount, now = new Date().toISOString() }) {
  const metrics = current && typeof current === "object" ? { ...current } : {};
  metrics.version = 1;
  metrics.observedBursts = Number(metrics.observedBursts || 0) + 1;
  metrics.observedMessages = Number(metrics.observedMessages || 0) + Math.max(1, Number(messageCount || 1));
  if (decision.wake) metrics.wakeBursts = Number(metrics.wakeBursts || 0) + 1;
  else if (mode === "enforce") metrics.suppressedBursts = Number(metrics.suppressedBursts || 0) + 1;
  else if (mode === "shadow") metrics.shadowWouldSuppressBursts = Number(metrics.shadowWouldSuppressBursts || 0) + 1;
  const reasons = { ...(metrics.reasons || {}) };
  reasons[decision.reason] = Number(reasons[decision.reason] || 0) + 1;
  metrics.reasons = reasons;
  metrics.updatedAt = now;
  return metrics;
}
