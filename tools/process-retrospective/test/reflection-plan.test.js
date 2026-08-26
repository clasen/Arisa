import test from "node:test";
import assert from "node:assert/strict";
import { buildReflectionPrompt, focusForPass } from "../reflection-plan.js";

test("rotates focus every four passes", () => {
  assert.equal(focusForPass(1, 4).id, "reliability");
  assert.equal(focusForPass(4, 4).id, "reliability");
  assert.equal(focusForPass(5, 4).id, "efficiency");
  assert.equal(focusForPass(9, 4).id, "quality");
  assert.equal(focusForPass(13, 4).id, "creative");
  assert.equal(focusForPass(17, 4).id, "reliability");
});

test("prompt is bounded and review-only", () => {
  const prompt = buildReflectionPrompt({
    passNumber: 13,
    passesPerFocus: 4,
    reviewWindowHours: 24,
    maxProposals: 3
  });
  assert.match(prompt, /Primary lens: creative alternatives and assumptions/);
  assert.match(prompt, /never limits the scope of the review/);
  assert.match(prompt, /general, reusable level rather than optimizing for one campaign/);
  assert.match(prompt, /reconstruct the whole review window rather than anchoring on the latest exchange/);
  assert.match(prompt, /beginning, middle, and end of the window/);
  assert.match(prompt, /repeated zero-result or no-change outcomes/);
  assert.match(prompt, /Query telemetry-ledger with action report using 24 hours/);
  assert.match(prompt, /correlated hypotheses—not proven causes/);
  assert.match(prompt, /between 1 and 3 small, testable improvements/);
  assert.match(prompt, /even when only one useful improvement is supported/);
  assert.match(prompt, /Do not modify code, configuration, schedules, drafts, messages, or external systems/);
  assert.match(prompt, /remain silent/);
});
