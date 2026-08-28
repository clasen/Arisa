const defaultCompactAtPersistedBytes = 24 * 1024 * 1024;
const defaultMaxPersistedBytes = 32 * 1024 * 1024;

export function normalizeSessionRotationPolicy(policy = {}) {
  const maxPersistedBytes = Math.max(1, Number(policy?.maxPersistedBytes) || defaultMaxPersistedBytes);
  return {
    enabled: policy?.enabled !== false,
    compactAtPersistedBytes: Math.min(
      maxPersistedBytes,
      Math.max(1, Number(policy?.compactAtPersistedBytes) || defaultCompactAtPersistedBytes)
    ),
    maxPersistedBytes
  };
}

export function compactionRotationRequest(event, persistedBytes, policy = {}) {
  const normalized = normalizeSessionRotationPolicy(policy);
  if (!normalized.enabled || event?.type !== "compaction_end" || event.aborted || event.errorMessage) return null;
  const summary = String(event.result?.summary || "").trim();
  if (!summary || Math.max(0, Number(persistedBytes) || 0) <= normalized.compactAtPersistedBytes) return null;
  return {
    handoff: [
      "Automatic session rotation after compaction. Continue from this checkpoint:",
      "",
      summary
    ].join("\n"),
    persistedBytes: Math.max(0, Number(persistedBytes) || 0)
  };
}
