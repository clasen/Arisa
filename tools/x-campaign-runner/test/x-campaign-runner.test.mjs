import test from "node:test";
import assert from "node:assert/strict";
import { availableCandidates, candidateScore, greetingNameFor, handleFromXUrl, hasGroundedCoverageEvidence, isUncertainDeliveryError, parseSearchResults, pendingApproval, renderMessage, sha256, targetBoundGreeting } from "../index.js";

test("extracts only real X profile handles", () => {
  assert.equal(handleFromXUrl("https://x.com/Good_Handle/status/123"), "Good_Handle");
  assert.equal(handleFromXUrl("https://twitter.com/Another"), "Another");
  assert.equal(handleFromXUrl("https://x.com/search?q=test"), "");
  assert.equal(handleFromXUrl("https://example.com/user"), "");
});

test("parses web-browser search results with provenance", () => {
  const results = parseSearchResults(`Search: test

1. Creator (@Creator) / X
URL: https://x.com/Creator
Snippet: Reviews narrative games`);
  assert.deepEqual(results, [{ title: "Creator (@Creator) / X", url: "https://x.com/Creator", snippet: "Reviews narrative games" }]);
});

test("scoring rewards close comparables and penalizes paid promotion", () => {
  const profile = { selection: { highValueKeywords: ["Duskwood"], includeKeywords: ["review"], excludeKeywords: ["paid promotion"] } };
  const good = candidateScore({ query: "Duskwood review", snippet: "indie games", evidenceTitle: "", reference: "Duskwood" }, profile);
  const bad = candidateScore({ query: "Duskwood review", snippet: "paid promotion agency", evidenceTitle: "", reference: "Duskwood" }, profile);
  assert.ok(good > bad);
});

test("coverage evidence must mention the reference on a specific post or article", () => {
  assert.equal(hasGroundedCoverageEvidence({
    reference: "SIMULACRA",
    evidenceTitle: "SIMULACRA review",
    snippet: "A review of the found-phone mystery game.",
    evidenceUrl: "https://x.com/reviewer/status/123"
  }), true);
  assert.equal(hasGroundedCoverageEvidence({
    reference: "SIMULACRA",
    evidenceTitle: "The philosophy of talking to AI",
    snippet: "A post about chatbots.",
    evidenceUrl: "https://x.com/writer/status/456"
  }), false);
  assert.equal(hasGroundedCoverageEvidence({
    reference: "interactive fiction",
    evidenceTitle: "Creator profile",
    snippet: "Creator @handle Follow",
    evidenceUrl: "https://x.com/handle"
  }), false);
});

test("message rendering is deterministic and includes the official site", () => {
  const candidate = { username: "Creator", displayName: "Creator", reference: "Sara Is Missing" };
  const profile = {
    siteUrl: "https://castlebravo.org",
    message: {
      openingTemplate: "I saw your {{reference}} coverage and thought Castle Bravo could fit your audience.",
      body: "A mobile mystery. {{siteUrl}}"
    }
  };
  const first = renderMessage(candidate, profile);
  assert.equal(first, renderMessage(candidate, profile));
  assert.match(first, /Sara Is Missing/);
  assert.match(first, /https:\/\/castlebravo\.org/);
  assert.doesNotMatch(first, /[—–]/);
  assert.ok(first.length < 1000);
});

test("only fresh discovered candidates are eligible", () => {
  const state = { candidates: [
    { username: "fresh", status: "discovered", score: 1 },
    { username: "uncertain", status: "manual-review", score: 99 },
    { username: "waiting", status: "awaiting-approval", score: 99 }
  ] };
  assert.deepEqual(availableCandidates(state, new Set()).map((item) => item.username), ["fresh"]);
});

test("pending approvals expire fail-closed", () => {
  const live = { approval: { status: "pending", expiresAt: new Date(Date.now() + 60000).toISOString() } };
  assert.equal(pendingApproval(live), live.approval);
  const expired = { approval: { status: "pending", expiresAt: new Date(Date.now() - 60000).toISOString() } };
  assert.equal(pendingApproval(expired), null);
  assert.equal(expired.approval.status, "expired");
});

test("approval hashes detect message tampering", () => {
  assert.equal(sha256("approved"), sha256("approved"));
  assert.notEqual(sha256("approved"), sha256("changed"));
});

test("uncertain send evidence failures are recognized", () => {
  assert.equal(isUncertainDeliveryError("X send could not be proven. Missing evidence: receipt."), true);
  assert.equal(isUncertainDeliveryError("Arisa IPC request timed out"), true);
  assert.equal(isUncertainDeliveryError("Daily cap reached."), false);
});


test("first-name greetings require verified identity or profile-seed overrides", () => {
  const profile = { message: { greetingMode: "first-name" } };
  assert.throws(
    () => greetingNameFor({ username: "JohnWolfeYT", displayName: "John Wolfe" }, profile),
    /no verified personal first name/
  );
  assert.equal(greetingNameFor({ username: "JohnWolfeYT", verifiedGreetingName: "John" }, profile), "John");
  assert.equal(
    greetingNameFor({ username: "Creator", displayName: "Public Name", source: "profile-seed", greetingName: "Sam" }, profile),
    "Sam"
  );
});

test("display-name greetings do not require a verified personal first name", () => {
  const profile = { message: { greetingMode: "display-name" } };
  assert.equal(greetingNameFor({ username: "Studio", displayName: "Studio Account" }, profile), "Studio Account");
});

test("revised greetings must remain grounded in the verified target identity", () => {
  const candidate = { username: "NorbezJones", verifiedDisplayName: "Bez: Interactive Fiction, Visual Novels, & Writing" };
  assert.equal(targetBoundGreeting(candidate, "Bez"), "Bez");
  assert.throws(() => targetBoundGreeting(candidate, "Alex"), /grounded in the verified target identity/);
});
