import test from "node:test";
import assert from "node:assert/strict";
import { availableCandidates, candidateScore, handleFromXUrl, parseSearchResults, pendingApproval, renderMessage, sha256 } from "../index.js";

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
