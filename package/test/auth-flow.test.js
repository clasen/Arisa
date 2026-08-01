import assert from "node:assert/strict";
import test from "node:test";
import { getErrorMessage, getPiAuthIssue } from "../src/core/agent/auth-flow.js";

test("extracts messages from Error instances and other thrown values", () => {
  assert.equal(getErrorMessage(new Error("boom")), "boom");
  assert.equal(getErrorMessage("plain failure"), "plain failure");
  assert.equal(getErrorMessage(404), "404");
});

test("classifies invalidated Pi authentication tokens", () => {
  for (const error of [
    new Error("authentication token has been invalidated"),
    new Error("Token invalidated by provider"),
    new Error("Please try signing in again"),
    new Error("auth token expired")
  ]) {
    assert.deepEqual(getPiAuthIssue(error), {
      kind: "invalidated-token",
      message: error.message
    });
  }
});

test("classifies missing Pi authentication", () => {
  for (const error of [
    new Error("No auth found for provider"),
    new Error("No API key for provider: openai-codex"),
    new Error('No API key found for "openai-codex"'),
    new Error("authentication credentials are missing")
  ]) {
    assert.deepEqual(getPiAuthIssue(error), {
      kind: "missing-auth",
      message: error.message
    });
  }
});

test("ignores unrelated Pi errors", () => {
  assert.equal(getPiAuthIssue(new Error("model rate limit exceeded")), null);
  assert.equal(getPiAuthIssue(new Error("")), null);
});
