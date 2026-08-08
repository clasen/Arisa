import test from "node:test";
import assert from "node:assert/strict";
import {
  auditState,
  campaignIdFrom,
  cooldownGuard,
  duplicateGuard,
  exactBoolean,
  failureCircuitGuard,
  messageHash,
  normalizeState,
  parseCookies,
  usernameFrom,
  withinDailyCap
} from "../index.js";

test("confirmation booleans require exact explicit values", () => {
  assert.equal(exactBoolean(true, true), true);
  assert.equal(exactBoolean("true", true), true);
  assert.equal(exactBoolean("yes", true), false);
  assert.equal(exactBoolean(undefined, false), false);
  assert.equal(exactBoolean("false", false), true);
});

test("handles and campaign ids are normalized", () => {
  assert.equal(usernameFrom("https://x.com/Target_1"), "Target_1");
  assert.equal(usernameFrom("hello @valid_name"), "valid_name");
  assert.equal(usernameFrom("@this_handle_is_far_too_long"), "");
  assert.equal(campaignIdFrom({ campaignId: "Castle Bravo / X" }), "Castle-Bravo-X");
});

test("legacy sends derive a durable recipient index", () => {
  const state = normalizeState({ sends: [{ username: "Example", sentAt: "2026-01-01T00:00:00Z" }] });
  assert.equal(state.recipientIndex.example.username, "Example");
  assert.match(duplicateGuard(state, "example", "new:key"), /recipient index/);
});

test("an unresolved reservation and uncertain delivery block retries", () => {
  const inFlight = normalizeState({ attempts: [{ attemptId: "a", at: new Date().toISOString(), username: "Target", idempotencyKey: "k", outcome: "in-flight" }] });
  assert.match(duplicateGuard(inFlight, "Target", "k"), /in-flight/);
  const uncertain = normalizeState({ attempts: [{ attemptId: "a", at: new Date().toISOString(), username: "Target", idempotencyKey: "k", outcome: "uncertain" }] });
  assert.match(duplicateGuard(uncertain, "Target", "k"), /uncertain/);
});

test("daily caps cannot be bypassed by changing campaign", () => {
  const today = new Date().toISOString();
  const state = normalizeState({ sends: [
    { username: "one", campaignId: "a", sentAt: today },
    { username: "two", campaignId: "b", sentAt: today }
  ] });
  assert.equal(withinDailyCap(state, "c", 2, 10).allowed, false);
  assert.equal(withinDailyCap(state, "a", 10, 1).allowed, false);
});

test("failure circuit opens after three recent terminal failures", () => {
  const at = new Date().toISOString();
  const state = normalizeState({ attempts: [1, 2, 3].map((n) => ({ attemptId: String(n), at, outcome: n === 3 ? "uncertain" : "failed" })) });
  assert.match(failureCircuitGuard(state), /circuit breaker/);
});

test("audit identifies duplicates, uncertainty, and unresolved reservations", () => {
  const state = normalizeState({
    sends: [
      { username: "Same", campaignId: "c", sentAt: "2026-01-01T00:00:00Z" },
      { username: "same", campaignId: "c", sentAt: "2026-01-01T00:01:00Z" }
    ],
    attempts: [
      { attemptId: "u", at: "2026-01-01T00:02:00Z", campaignId: "c", outcome: "uncertain" },
      { attemptId: "p", at: "2026-01-01T00:03:00Z", campaignId: "c", outcome: "in-flight" }
    ]
  });
  const audit = auditState(state, "c");
  assert.deepEqual(audit.duplicateRecipients, ["same"]);
  assert.equal(audit.uncertainDeliveries.length, 1);
  assert.equal(audit.unresolvedAttempts.length, 1);
});

test("cookie parsing and message hashes are deterministic", () => {
  assert.equal(parseCookies("auth_token=abc; ct0=def").length, 2);
  assert.equal(messageHash("same"), messageHash("same"));
  assert.notEqual(messageHash("same"), messageHash("different"));
});

test("cooldown reports the remaining wait", () => {
  const state = normalizeState({ sends: [{ username: "one", sentAt: new Date().toISOString() }] });
  assert.match(cooldownGuard(state, 60), /Cooldown active/);
});
