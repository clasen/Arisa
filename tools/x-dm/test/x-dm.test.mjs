import test from "node:test";
import assert from "node:assert/strict";
import {
  assessDeliveryEvidence,
  auditState,
  bioWithAppend,
  campaignIdFrom,
  checkedBio,
  comparableBio,
  cooldownGuard,
  duplicateGuard,
  exactBoolean,
  failureCircuitGuard,
  followSafetyGuard,
  isCandidateRelationshipResponse,
  messageHash,
  normalizeState,
  parseCookies,
  publicReplyGuard,
  replyTarget,
  requestTargetsUser,
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
  const inFlight = normalizeState({ attempts: [{ attemptId: "a", action: "send", at: new Date().toISOString(), username: "Target", idempotencyKey: "k", outcome: "in-flight" }] });
  assert.match(duplicateGuard(inFlight, "Target", "k"), /in-flight/);
  const uncertain = normalizeState({ attempts: [{ attemptId: "a", action: "send", at: new Date().toISOString(), username: "Target", idempotencyKey: "k", outcome: "uncertain" }] });
  assert.match(duplicateGuard(uncertain, "Target", "k"), /uncertain/);
});

test("a later profile check cannot mask an uncertain send", () => {
  const state = normalizeState({ attempts: [
    { attemptId: "send-a", action: "send", at: new Date().toISOString(), username: "Target", idempotencyKey: "k", outcome: "uncertain" },
    { attemptId: "check-b", action: "check", at: new Date().toISOString(), username: "Target", outcome: "dm-available" }
  ] });
  assert.match(duplicateGuard(state, "Target", "k"), /uncertain/);
});

test("delivery verification requires every concrete evidence signal", () => {
  const complete = {
    conversationBound: true,
    composerCleared: true,
    newScopedExactMessages: 1,
    explicitError: false,
    networkReceipt: { valid: true }
  };
  assert.deepEqual(assessDeliveryEvidence(complete), { verified: true, missing: [] });
  for (const mutation of [
    { conversationBound: false },
    { composerCleared: false },
    { newScopedExactMessages: 0 },
    { explicitError: true },
    { networkReceipt: null }
  ]) {
    assert.equal(assessDeliveryEvidence({ ...complete, ...mutation }).verified, false);
  }
});

test("a draft or unrelated network response cannot prove delivery", () => {
  const result = assessDeliveryEvidence({
    conversationBound: true,
    composerCleared: false,
    newScopedExactMessages: 0,
    explicitError: false,
    networkReceipt: { valid: false }
  });
  assert.equal(result.verified, false);
  assert.ok(result.missing.includes("composer-clear"));
  assert.ok(result.missing.includes("new-exact-message-in-target-list"));
  assert.ok(result.missing.includes("matching-x-send-receipt"));
});

test("human-confirmed not-sent resolves an uncertain block", () => {
  const state = normalizeState({ attempts: [
    { attemptId: "a", action: "send", at: new Date().toISOString(), username: "Target", idempotencyKey: "k", outcome: "uncertain" },
    { attemptId: "a", action: "send", at: new Date().toISOString(), username: "Target", idempotencyKey: "k", outcome: "not-sent" }
  ] });
  assert.equal(duplicateGuard(state, "Target", "k"), "");
  assert.equal(auditState(state).uncertainDeliveries.length, 0);
  assert.equal(auditState(state).unresolvedAttempts.length, 0);
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

test("bio helpers enforce length, avoid duplicate appends, and tolerate X URL normalization", () => {
  assert.equal(checkedBio(" PR for Example Studio "), "PR for Example Studio");
  assert.throws(() => checkedBio("x".repeat(161)), /160 characters/);
  assert.equal(bioWithAppend("Arisa", "PR for Example Studio"), "Arisa | PR for Example Studio");
  assert.equal(bioWithAppend("Arisa | PR for Example Studio", "PR for Example Studio"), "Arisa | PR for Example Studio");
  assert.equal(comparableBio("example.org"), comparableBio("http://example.org"));
  assert.equal(comparableBio("https://example.org"), comparableBio("http://example.org"));
});


test("state migration preserves follow records and follow safety caps verified changes", () => {
  const state = normalizeState({ follows: { creator: { username: "Creator", status: "following" } }, attempts: [] });
  assert.equal(state.version, 3);
  assert.equal(state.follows.creator.status, "following");
  state.attempts = Array.from({ length: 2 }, (_, index) => ({ action: "follow", outcome: "following", at: new Date().toISOString(), attemptId: String(index) }));
  assert.match(followSafetyGuard(state, 2, 0), /Daily follow cap/);
});

test("public reply targets and safeguards are exact and deduplicated", () => {
  const target = replyTarget("https://x.com/example/status/1234567890?s=20");
  assert.deepEqual(target, { username: "example", tweetId: "1234567890", url: "https://x.com/example/status/1234567890" });
  assert.throws(() => replyTarget("https://example.com/example/status/1234567890"), /only accepts x.com/);
  assert.doesNotThrow(() => publicReplyGuard(normalizeState({}), target, { MAX_REPLIES_PER_DAY: "3", MIN_SECONDS_BETWEEN_REPLIES: "60" }));
  assert.throws(() => publicReplyGuard(normalizeState({ replies: [{ targetTweetId: "1234567890", repliedAt: new Date().toISOString() }] }), target, {}), /already received/);
});

test("relationship receipts must name the exact target and expected action", () => {
  const request = { postData: () => JSON.stringify({ variables: { target_user_id: "12345" } }), method: () => "POST" };
  assert.equal(requestTargetsUser(request, "12345"), true);
  assert.equal(requestTargetsUser(request, "99999"), false);
  const followResponse = { request: () => request, url: () => "https://x.com/i/api/graphql/hash/CreateFriendship" };
  assert.equal(isCandidateRelationshipResponse(followResponse, true), true);
  assert.equal(isCandidateRelationshipResponse(followResponse, false), false);
});
