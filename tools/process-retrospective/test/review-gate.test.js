import assert from "node:assert/strict";
import test from "node:test";
import {
  collectReviewSignals,
  correctionSignalIds,
  evaluateReviewGate,
  signalFingerprint,
  taskFailureSignalIds,
  telemetryRegressionSignalIds
} from "../review-gate.js";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const since = now - 86_400_000;

test("extracts only bounded correction, failure, and regression signals", () => {
  const artifacts = [
    { id: "a", createdAt: "2026-09-03T10:00:00.000Z", source: { type: "telegram" }, text: "Esto no funciona, corregilo" },
    { id: "b", createdAt: "2026-09-03T11:00:00.000Z", source: { type: "telegram" }, text: "excelente" },
    { id: "c", createdAt: "2026-09-01T11:00:00.000Z", source: { type: "telegram" }, text: "error antiguo" },
    { id: "d", createdAt: "2026-09-03T11:00:00.000Z", source: { type: "tool" }, text: "error" }
  ];
  assert.deepEqual(correctionSignalIds(artifacts, { since }), ["correction:a"]);
  assert.deepEqual(taskFailureSignalIds([
    { id: "failed", updatedAt: "2026-09-03T09:00:00.000Z" },
    { id: "old", updatedAt: "2026-09-01T09:00:00.000Z" }
  ], { since, status: "failed" }), ["task:failed:failed"]);
  assert.deepEqual(telemetryRegressionSignalIds({ output: { json: { comparisons: [
    { metric: "tool.latency_ms", status: "regression" },
    { metric: "campaign.yield", status: "stable" }
  ] } } }), ["telemetry:regression:tool.latency_ms"]);
});

test("skips unchanged signals but forces a complete daily review", () => {
  const first = evaluateReviewGate({ state: {}, signalIds: [], forceReviewAfterMs: 86_400_000, now });
  assert.equal(first.shouldReview, true);
  assert.equal(first.reason, "first-review");

  const unchanged = evaluateReviewGate({
    state: first.nextState,
    signalIds: [],
    forceReviewAfterMs: 86_400_000,
    now: now + 3_600_000
  });
  assert.equal(unchanged.shouldReview, false);
  assert.equal(unchanged.nextState.gateSkips, 1);

  const signaled = evaluateReviewGate({
    state: unchanged.nextState,
    signalIds: ["correction:new"],
    forceReviewAfterMs: 86_400_000,
    now: now + 7_200_000
  });
  assert.equal(signaled.shouldReview, true);
  assert.equal(signaled.reason, "new-signal");
  assert.deepEqual(signaled.novelSignals, ["correction:new"]);

  const forced = evaluateReviewGate({
    state: signaled.nextState,
    signalIds: ["correction:new"],
    forceReviewAfterMs: 86_400_000,
    now: now + 7_200_000 + 86_400_000
  });
  assert.equal(forced.shouldReview, true);
  assert.equal(forced.reason, "periodic-review");
  assert.equal(forced.nextState.forcedReviews, 1);
});

test("fails open when deterministic signal collection is incomplete", () => {
  const decision = evaluateReviewGate({
    state: { lastReasonedAt: new Date(now).toISOString(), currentSignalIds: [] },
    signalIds: [],
    incomplete: true,
    forceReviewAfterMs: 86_400_000,
    now: now + 1_000
  });
  assert.equal(decision.shouldReview, true);
  assert.equal(decision.reason, "signal-check-incomplete");
});

test("collects signals without failing when optional telemetry is unavailable", async () => {
  const arisa = {
    artifacts: { listRecent: async () => [{ id: "a", createdAt: new Date(now).toISOString(), source: { type: "telegram" }, text: "corregir error" }] },
    tasks: { list: async ({ status }) => status === "failed" ? [{ id: "f", updatedAt: new Date(now).toISOString() }] : [] },
    tools: { run: async () => { throw new Error("telemetry unavailable"); } }
  };
  const result = await collectReviewSignals(arisa, { reviewWindowHours: 24, now });
  assert.equal(result.incomplete, false);
  assert.equal(result.telemetryAvailable, false);
  assert.deepEqual(result.signalIds, ["correction:a", "task:failed:f"]);
  assert.equal(signalFingerprint(result.signalIds), signalFingerprint([...result.signalIds].reverse()));
});
