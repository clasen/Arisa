function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const CORRECTION_DISPOSITION = /correction|correcting|corrective|corrections|exact-remaining-lines|requesting-final-language-removal/i;

export function isCorrectionDisposition(disposition) {
  return CORRECTION_DISPOSITION.test(String(disposition || ""));
}

export function secretaryCorrectionStreak(rawState, threadId) {
  const state = normalizeSecretaryState(rawState);
  const records = Object.values(state.messages)
    .filter((record) => record?.threadId === threadId && record.ackedAt && record.disposition !== "superseded")
    .sort((left, right) => Date.parse(right.ackedAt) - Date.parse(left.ackedAt));
  let streak = 0;
  for (const record of records) {
    if (!isCorrectionDisposition(record.disposition)) break;
    streak += 1;
  }
  return streak;
}

export function normalizeSecretaryState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const messages = state.messages && typeof state.messages === "object" && !Array.isArray(state.messages) ? state.messages : {};
  return { version: 2, messages };
}

export function selectSecretaryWake(messages, rawState, options = {}) {
  const now = new Date(options.now || Date.now());
  const retrySeconds = Math.max(60, Number(options.retrySeconds || 600));
  const maxWake = Math.max(1, Math.min(Number(options.maxWake || 20), 100));
  const correctionGateThreshold = Math.max(2, Math.min(Number(options.correctionGateThreshold || 2), 10));
  const state = normalizeSecretaryState(rawState);
  const selected = [];
  const newestMessageByThread = new Map();
  for (const message of messages || []) {
    const id = String(message?.id || "");
    if (!id) continue;
    const existing = state.messages[id] || {};
    const threadId = String(message.threadId || existing.threadId || id);
    const record = {
      ...existing,
      id,
      threadId,
      firstSeenAt: existing.firstSeenAt || iso(now),
      lastSeenAt: iso(now)
    };
    state.messages[id] = record;

    const newerId = newestMessageByThread.get(threadId);
    if (newerId) {
      if (!record.ackedAt) {
        record.ackedAt = iso(now);
        record.disposition = "superseded";
        record.supersededBy = newerId;
      }
      continue;
    }
    newestMessageByThread.set(threadId, id);

    if (record.ackedAt) continue;
    const lastWakeMs = record.lastWakeAt ? Date.parse(record.lastWakeAt) : 0;
    if (lastWakeMs && now.getTime() - lastWakeMs < retrySeconds * 1000) continue;
    if (selected.length >= maxWake) continue;
    record.lastWakeAt = iso(now);
    record.wakeCount = Number(record.wakeCount || 0) + 1;
    const correctionReplyCount = secretaryCorrectionStreak(state, threadId);
    selected.push({
      id,
      threadId: record.threadId,
      wakeCount: record.wakeCount,
      correctionGate: {
        blocked: correctionReplyCount >= correctionGateThreshold,
        correctionReplyCount,
        threshold: correctionGateThreshold
      }
    });
  }
  const entries = Object.entries(state.messages).sort((a, b) => Date.parse(b[1].lastSeenAt || 0) - Date.parse(a[1].lastSeenAt || 0)).slice(0, 2000);
  state.messages = Object.fromEntries(entries);
  state.updatedAt = iso(now);
  return { state, selected };
}

export function acknowledgeSecretaryMessages(rawState, ids, disposition = "handled", now = new Date()) {
  const state = normalizeSecretaryState(rawState);
  const acknowledged = [];
  for (const value of ids || []) {
    const id = String(value || "").trim();
    if (!id) continue;
    const existing = state.messages[id] || { id, firstSeenAt: iso(now), lastSeenAt: iso(now), wakeCount: 0 };
    state.messages[id] = { ...existing, ackedAt: iso(now), disposition: String(disposition || "handled") };
    acknowledged.push(id);
  }
  state.updatedAt = iso(now);
  return { state, acknowledged };
}
