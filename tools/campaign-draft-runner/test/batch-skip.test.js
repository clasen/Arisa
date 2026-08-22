import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  campaignStateFingerprint,
  canArmUnchangedBatchSkip,
  evaluateUnchangedBatch,
  recordFullBatchReview
} from "../batch-skip.js";

test("campaign fingerprints are stable across key and recipient order", () => {
  const first = campaignStateFingerprint({
    profile: { name: "example", selection: { b: 2, a: 1 } },
    campaign: { contacts: 10, sent: 4 },
    draftRecipients: new Set(["b@example.com", "a@example.com"]),
    discovery: { cursor: 2 },
    factStatus: { approvedFacts: { availability: "public" } }
  });
  const second = campaignStateFingerprint({
    factStatus: { approvedFacts: { availability: "public" } },
    discovery: { cursor: 2 },
    draftRecipients: new Set(["a@example.com", "b@example.com"]),
    campaign: { sent: 4, contacts: 10 },
    profile: { selection: { a: 1, b: 2 }, name: "example" }
  });
  assert.equal(first, second);
});

test("unchanged batches skip until the forced review deadline", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "campaign-batch-skip-"));
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  try {
    const first = await evaluateUnchangedBatch({
      stateDir,
      profileName: "example",
      fingerprint: "same",
      forceReviewAfterMs: 6 * 3600000,
      now
    });
    assert.deepEqual({ skip: first.skip, reason: first.reason }, { skip: false, reason: "first-review" });

    await recordFullBatchReview({
      stateDir,
      profileName: "example",
      fingerprint: "same",
      summary: { candidates: 20, eligiblePool: 0, poolTarget: 1 },
      now
    });
    const unchanged = await evaluateUnchangedBatch({
      stateDir,
      profileName: "example",
      fingerprint: "same",
      forceReviewAfterMs: 6 * 3600000,
      now: now + 3600000
    });
    assert.equal(unchanged.skip, true);
    assert.equal(unchanged.skippedSinceFull, 1);
    assert.equal(unchanged.lastFullSummary.candidates, 20);

    const changed = await evaluateUnchangedBatch({
      stateDir,
      profileName: "example",
      fingerprint: "different",
      forceReviewAfterMs: 6 * 3600000,
      now: now + 2 * 3600000
    });
    assert.deepEqual({ skip: changed.skip, reason: changed.reason }, { skip: false, reason: "state-changed" });

    const periodic = await evaluateUnchangedBatch({
      stateDir,
      profileName: "example",
      fingerprint: "same",
      forceReviewAfterMs: 6 * 3600000,
      now: now + 6 * 3600000
    });
    assert.deepEqual({ skip: periodic.skip, reason: periodic.reason }, { skip: false, reason: "periodic-review" });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("only clean empty full batches arm unchanged skipping", () => {
  const base = {
    action: "run-batch",
    dryRun: false,
    drafted: 0,
    eligiblePool: 0,
    selected: [],
    discovery: { errors: 0 },
    creativeDiscovery: { errors: 0 }
  };
  assert.equal(canArmUnchangedBatchSkip(base), true);
  assert.equal(canArmUnchangedBatchSkip({ ...base, discovery: { errors: 1 } }), false);
  assert.equal(canArmUnchangedBatchSkip({ ...base, selected: [{ email: "retry@example.com" }] }), false);
  assert.equal(canArmUnchangedBatchSkip({ ...base, drafted: 1 }), false);
  assert.equal(canArmUnchangedBatchSkip({ ...base, dryRun: true }), false);
});
