import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyIncomingWake,
  normalizeWakeGateMode,
  updateWakeGateMetrics,
  wakeGateResourceIds
} from "../incoming-wake-gate.js";

function item(body, { type = "chat", artifact = null } = {}) {
  return { message: { body, type }, artifact, transcript: "" };
}

test("normalizes exact resource ids and fail-safe gate modes", () => {
  assert.deepEqual([...wakeGateResourceIds("a@g.us, b@c.us, a@g.us")], ["a@g.us", "b@c.us"]);
  assert.equal(normalizeWakeGateMode("ENFORCE"), "enforce");
  assert.equal(normalizeWakeGateMode("unknown"), "off");
  assert.deepEqual(classifyIncomingWake([item("named persona hello")]), { wake: false, reason: "passive-chatter" });
});

test("keeps passive chatter silent while waking explicit or actionable input", () => {
  assert.deepEqual(classifyIncomingWake([
    item("https://example.com/reel/123"),
    item("era enorme ese edificio")
  ], { bypassNames: ["helper"] }), { wake: false, reason: "passive-chatter" });

  assert.deepEqual(classifyIncomingWake([item("Helper, qué opinás")], { bypassNames: ["helper"] }), {
    wake: true,
    reason: "explicit-invocation"
  });
  assert.equal(classifyIncomingWake([item("qué opinan?")]).reason, "question");
  assert.equal(classifyIncomingWake([item("podés revisar esto")]).reason, "actionable-text");
  assert.equal(classifyIncomingWake([item("", { type: "ptt", artifact: { id: "audio" } })]).reason, "actionable-media");
});

test("records bounded shadow and enforced gate counters without message content", () => {
  const shadow = updateWakeGateMetrics({}, {
    mode: "shadow",
    decision: { wake: false, reason: "passive-chatter" },
    messageCount: 3,
    now: "2026-08-26T00:00:00.000Z"
  });
  const enforced = updateWakeGateMetrics(shadow, {
    mode: "enforce",
    decision: { wake: false, reason: "passive-chatter" },
    messageCount: 1,
    now: "2026-08-26T00:01:00.000Z"
  });

  assert.equal(enforced.observedBursts, 2);
  assert.equal(enforced.observedMessages, 4);
  assert.equal(enforced.shadowWouldSuppressBursts, 1);
  assert.equal(enforced.suppressedBursts, 1);
  assert.deepEqual(enforced.reasons, { "passive-chatter": 2 });
  assert.doesNotMatch(JSON.stringify(enforced), /reel|edificio/i);
});
