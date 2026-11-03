import crypto from "node:crypto";

const CORRECTION_PATTERN = /\b(correg\w*|correction\w*|wrong|incorrect\w*|mal|error\w*|fall[oa]\w*|regresi\w*|dej[oó]\s+de|no\s+funciona\w*|deber[ií]a\w*|repet\w*|duplic\w*|lent\w*|latenc\w*|perdi[oó]\w*|sin\s+respuesta|retry|reintenta\w*)\b/i;

function array(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.tasks)) return value.tasks;
  return [];
}

function withinWindow(value, since) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) && timestamp >= since;
}

function resultValue(settled, fallback) {
  return settled.status === "fulfilled" ? settled.value : fallback;
}

function telemetryComparisons(result) {
  return result?.output?.json?.comparisons || result?.json?.comparisons || [];
}

export function correctionSignalIds(artifacts, { since }) {
  return array(artifacts)
    .filter((artifact) => artifact?.source?.type === "telegram")
    .filter((artifact) => withinWindow(artifact.createdAt, since))
    .filter((artifact) => CORRECTION_PATTERN.test(String(artifact.text || "")))
    .map((artifact) => `correction:${artifact.id}`);
}

export function taskFailureSignalIds(tasks, { since, status }) {
  return array(tasks)
    .filter((task) => withinWindow(task.updatedAt || task.completedAt || task.runAt, since))
    .map((task) => `task:${status}:${task.id}`);
}

export function telemetryRegressionSignalIds(report) {
  return array(telemetryComparisons(report))
    .filter((comparison) => comparison?.status === "regression")
    .map((comparison) => `telemetry:regression:${comparison.metric}`);
}

export function signalFingerprint(signalIds) {
  const material = [...new Set(signalIds.map(String))].sort();
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export async function collectReviewSignals(arisa, { reviewWindowHours = 24, limit = 100, now = Date.now() } = {}) {
  const boundedLimit = Math.max(10, Math.min(100, Number(limit) || 100));
  const windowHours = Math.max(1, Math.min(168, Number(reviewWindowHours) || 24));
  const since = now - (windowHours * 3_600_000);
  const [artifactsResult, failedResult, blockedResult, telemetryResult] = await Promise.allSettled([
    arisa.artifacts.listRecent({ limit: boundedLimit }),
    arisa.tasks.list({ status: "failed", limit: boundedLimit }),
    arisa.tasks.list({ status: "blocked_auth", limit: boundedLimit }),
    arisa.tools.run({
      name: "telemetry-ledger",
      args: { action: "report", currentHours: String(windowHours), baselineHours: String(windowHours) }
    }, { timeoutMs: 15_000 })
  ]);
  const signalIds = [
    ...correctionSignalIds(resultValue(artifactsResult, []), { since }),
    ...taskFailureSignalIds(resultValue(failedResult, []), { since, status: "failed" }),
    ...taskFailureSignalIds(resultValue(blockedResult, []), { since, status: "blocked_auth" }),
    ...telemetryRegressionSignalIds(resultValue(telemetryResult, null))
  ];
  return {
    signalIds: [...new Set(signalIds)].sort(),
    incomplete: artifactsResult.status !== "fulfilled"
      || failedResult.status !== "fulfilled"
      || blockedResult.status !== "fulfilled",
    telemetryAvailable: telemetryResult.status === "fulfilled"
  };
}

export function evaluateReviewGate({ state = {}, signalIds = [], incomplete = false, forceReviewAfterMs, now = Date.now() }) {
  const currentSignalIds = [...new Set(signalIds.map(String))].sort().slice(-200);
  const previousSignalIds = new Set((state.currentSignalIds || []).map(String));
  const novelSignals = currentSignalIds.filter((signal) => !previousSignalIds.has(signal));
  const lastReasonedAt = Date.parse(state.lastReasonedAt || "");
  const forceDue = !Number.isFinite(lastReasonedAt) || now - lastReasonedAt >= forceReviewAfterMs;
  const shouldReview = incomplete || forceDue || novelSignals.length > 0;
  const reason = incomplete
    ? "signal-check-incomplete"
    : forceDue
      ? (Number.isFinite(lastReasonedAt) ? "periodic-review" : "first-review")
      : novelSignals.length
        ? "new-signal"
        : "unchanged";
  return {
    shouldReview,
    reason,
    novelSignals,
    fingerprint: signalFingerprint(currentSignalIds),
    nextState: {
      ...state,
      currentSignalIds,
      lastSignalFingerprint: signalFingerprint(currentSignalIds),
      lastGateAt: new Date(now).toISOString(),
      gateChecks: Number(state.gateChecks || 0) + 1,
      gateSkips: Number(state.gateSkips || 0) + (shouldReview ? 0 : 1),
      reasonedTurns: Number(state.reasonedTurns || 0) + (shouldReview ? 1 : 0),
      forcedReviews: Number(state.forcedReviews || 0) + (reason === "periodic-review" ? 1 : 0),
      ...(shouldReview ? { lastReasonedAt: new Date(now).toISOString() } : {})
    }
  };
}
