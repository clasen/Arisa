import assert from "node:assert/strict";
import test from "node:test";
import { buildTargetValidation } from "../target-validation.js";

function validation(overrides = {}) {
  return buildTargetValidation({
    action: "bookmarks",
    username: "",
    posts: [{ url: "https://x.com/a/status/1" }],
    requested: 250,
    attempts: 20,
    idle: 12,
    idleLimit: 12,
    emptyStateVisible: false,
    sessionSource: "browser-session-bridge",
    capturedAt: "2026-08-28T00:00:00.000Z",
    receivedAt: "2026-08-28T00:01:00.000Z",
    ...overrides
  });
}

test("separates shared authorization from validated target evidence", () => {
  const result = validation();
  assert.equal(result.authorization.status, "session_shared");
  assert.equal(result.target.status, "validated");
  assert.equal(result.target.evidence, "visible_posts");
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.stopReason, "idle_exhausted");
});

test("marks target validation inconclusive when authorization yields no evidence", () => {
  const result = validation({ posts: [], idle: 2, attempts: 8 });
  assert.equal(result.authorization.status, "session_shared");
  assert.equal(result.target.status, "inconclusive");
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.stopReason, "scroll_budget");
});

test("reports bounded coverage instead of claiming a complete export", () => {
  const result = validation({ posts: Array.from({ length: 250 }, (_, index) => ({ index })), idle: 0 });
  assert.equal(result.target.status, "validated");
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.stopReason, "requested_limit");
});
