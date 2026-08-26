function boundedWindow(value, fallback = 4000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(15_000, Math.round(parsed))) : fallback;
}

export function burstBypassNames(value = "peter") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 10);
}

export function explicitlyInvokesBypassName(text, names = ["peter"]) {
  const normalized = String(text || "").toLowerCase();
  return names.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, "iu").test(normalized);
  });
}

function burstKey(ownerChatId, message) {
  return `${ownerChatId}:${message.from}`;
}

function burstItem(message, artifact, transcript) {
  return {
    message,
    artifact: artifact ? {
      id: artifact.id,
      mimeType: artifact.mimeType || "",
      kind: artifact.kind || ""
    } : null,
    transcript: String(transcript || "")
  };
}

export function createMessageBurstCoordinator({
  readState,
  writeState,
  enqueue,
  windowMs = 4000,
  bypassNames = ["peter"],
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const delayMs = boundedWindow(windowMs);
  const timers = new Map();
  const lanes = new Map();

  function serialized(ownerChatId, operation) {
    const previous = lanes.get(ownerChatId) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    lanes.set(ownerChatId, next);
    return next.finally(() => {
      if (lanes.get(ownerChatId) === next) lanes.delete(ownerChatId);
    });
  }

  function schedule(ownerChatId, key, dueAt) {
    if (timers.has(key)) clearTimer(timers.get(key));
    const timer = setTimer(() => {
      timers.delete(key);
      flush(ownerChatId, key).catch(() => {});
    }, Math.max(0, dueAt - now()));
    timer?.unref?.();
    timers.set(key, timer);
  }

  async function flush(ownerChatId, key) {
    return serialized(ownerChatId, async () => {
      const state = await readState(ownerChatId);
      const burst = state.bursts?.[key];
      if (!burst) return false;
      if (burst.dueAt > now()) {
        schedule(ownerChatId, key, burst.dueAt);
        return false;
      }
      await enqueue(ownerChatId, burst.items);
      delete state.bursts[key];
      await writeState(ownerChatId, state);
      return true;
    });
  }

  async function add(ownerChatId, message, artifact = null, transcript = "") {
    return serialized(ownerChatId, async () => {
      const state = await readState(ownerChatId);
      state.bursts ||= {};
      const key = burstKey(ownerChatId, message);
      const existing = state.bursts[key]?.items || [];
      const items = [...existing, burstItem(message, artifact, transcript)].slice(-50);
      const text = transcript || message.body || "";
      const bypass = explicitlyInvokesBypassName(text, bypassNames);
      const dueAt = bypass ? now() : now() + delayMs;
      state.bursts[key] = { dueAt, items };
      await writeState(ownerChatId, state);
      if (bypass || delayMs === 0) {
        if (timers.has(key)) clearTimer(timers.get(key));
        timers.delete(key);
        await enqueue(ownerChatId, items);
        delete state.bursts[key];
        await writeState(ownerChatId, state);
        return { bypassed: true, count: items.length };
      }
      schedule(ownerChatId, key, dueAt);
      return { bypassed: false, count: items.length };
    });
  }

  async function recover(ownerChatId) {
    return serialized(ownerChatId, async () => {
      const state = await readState(ownerChatId);
      for (const [key, burst] of Object.entries(state.bursts || {})) {
        schedule(ownerChatId, key, Number(burst.dueAt || now()));
      }
      return Object.keys(state.bursts || {}).length;
    });
  }

  return { add, flush, recover };
}
