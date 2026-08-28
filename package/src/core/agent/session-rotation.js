const defaultMaxPersistedBytes = 64 * 1024 * 1024;

export function normalizeSessionRotationPolicy(policy = {}) {
  return {
    enabled: policy?.enabled !== false,
    maxPersistedBytes: Math.max(1, Number(policy?.maxPersistedBytes) || defaultMaxPersistedBytes)
  };
}

export function compactionRotationRequest(event, persistedBytes, policy = {}) {
  const normalized = normalizeSessionRotationPolicy(policy);
  if (!normalized.enabled || event?.type !== "compaction_end" || event.aborted || event.errorMessage) return null;
  const summary = String(event.result?.summary || "").trim();
  if (!summary || Math.max(0, Number(persistedBytes) || 0) <= normalized.maxPersistedBytes) return null;
  return {
    handoff: [
      "Automatic session rotation after compaction. Continue from this checkpoint:",
      "",
      summary
    ].join("\n"),
    persistedBytes: Math.max(0, Number(persistedBytes) || 0)
  };
}
