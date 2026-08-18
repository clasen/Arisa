import test from "node:test";
import assert from "node:assert/strict";
import { classifyContextTimeout } from "../operation-timeout.js";

test("context mutations report uncertain outcomes after a timeout", () => {
  const result = classifyContextTimeout(new Error("context-vault daemon job timed out after 120000ms"), "remember");
  assert.equal(result.status, "outcome_uncertain");
  assert.equal(result.operation.mutating, true);
  assert.equal(result.resolution.type, "check_operation_status");
});

test("context reads remain retry-safe after a timeout", () => {
  const result = classifyContextTimeout(new Error("Arisa IPC request timed out"), "recall");
  assert.equal(result.status, "timed_out");
  assert.equal(result.operation.mutating, false);
  assert.equal(result.resolution.type, "retry_safe");
  assert.equal(classifyContextTimeout(new Error("validation failed"), "remember"), null);
});
