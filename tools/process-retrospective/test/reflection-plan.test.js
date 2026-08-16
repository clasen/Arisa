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
  assert.match(prompt, /creative alternatives and assumptions/);
  assert.match(prompt, /at most 3 small, testable improvements/);
  assert.match(prompt, /Do not modify code, configuration, schedules, drafts, messages, or external systems/);
  assert.match(prompt, /remain silent/);
});
