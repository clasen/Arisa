import assert from "node:assert/strict";
import test from "node:test";
import { compareWindows, filterEvents, summarizeByMetric } from "../analysis.js";
import { validateDefinition, validateRecord } from "../validation.js";

const definitions = {
  "tool.latency_ms": { metric: "tool.latency_ms", kind: "duration", unit: "ms", direction: "lower", dimensions: ["tool", "status"] }
};

function event(value, timestamp, tool = "gmail") {
  return validateRecord({ metric: "tool.latency_ms", value, timestamp, dimensions: { tool, status: "ok" } }, definitions["tool.latency_ms"]);
}

test("validates low-cardinality metric definitions and records", () => {
  assert.deepEqual(validateDefinition(definitions["tool.latency_ms"]), { ...definitions["tool.latency_ms"], description: "" });
  assert.equal(event(120, "2026-08-18T00:00:00Z").value, 120);
  assert.throws(() => validateRecord({ metric: "tool.latency_ms", value: 1, dimensions: { email: "x@example.com" } }, definitions["tool.latency_ms"]), /unsafe dimension key/);
  assert.throws(() => validateRecord({ metric: "tool.latency_ms", value: 1, dimensions: { campaign: "x" } }, definitions["tool.latency_ms"]), /not declared/);
});

test("summarizes latency distributions", () => {
  const events = [event(100, "2026-08-18T00:00:00Z"), event(200, "2026-08-18T01:00:00Z"), event(300, "2026-08-18T02:00:00Z")];
  const summary = summarizeByMetric(events, definitions)[0];
  assert.equal(summary.average, 200);
  assert.equal(summary.p50, 200);
  assert.equal(summary.p95, 290);
});

test("classifies regressions and reports dimension correlations as hypotheses", () => {
  const baselineEvents = [100, 110, 120].map((value, index) => event(value, `2026-08-18T0${index}:00:00Z`));
  const currentEvents = [200, 220, 240].map((value, index) => event(value, `2026-08-19T0${index}:00:00Z`));
  const result = compareWindows({ baselineEvents, currentEvents, definitions, thresholdPercent: 10, minimumSamples: 3, groupBy: ["tool"] });
  assert.equal(result.comparisons[0].status, "regression");
  assert.equal(result.hypotheses[0].dimension, "tool");
  assert.match(result.hypotheses[0].note, /not a proven cause/);
});

test("filters wildcard metrics and dimensions", () => {
  const events = [event(100, "2026-08-18T00:00:00Z", "gmail"), event(200, "2026-08-18T01:00:00Z", "browser")];
  assert.equal(filterEvents(events, { metrics: ["tool.*"], dimensions: { tool: "gmail" } }).length, 1);
});
