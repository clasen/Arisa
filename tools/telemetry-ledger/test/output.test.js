import test from "node:test";
import assert from "node:assert/strict";
import { compactReport, formatQueryText, formatReportText } from "../output.js";

const report = {
  baseline: { since: "a", until: "b" },
  current: { since: "b", until: "c" },
  comparisons: [{
    status: "regression",
    baselineValue: 10,
    currentValue: 12,
    delta: 2,
    deltaPercent: 20,
    baseline: { metric: "tool.latency_ms", samples: 4, p95: 11, sum: 40, average: 10 },
    current: { metric: "tool.latency_ms", samples: 5, p95: 14, sum: 60, average: 12 }
  }],
  hypotheses: []
};

test("compact reports retain decisions and sample evidence without nested summaries", () => {
  const compact = compactReport(report);
  assert.deepEqual(compact.comparisons[0], {
    metric: "tool.latency_ms",
    status: "regression",
    baselineValue: 10,
    currentValue: 12,
    delta: 2,
    deltaPercent: 20,
    baselineSamples: 4,
    currentSamples: 5,
    baselineP95: 11,
    currentP95: 14
  });
  assert.ok(JSON.stringify(compact).length < JSON.stringify(report).length);
});

test("human text summarizes rather than duplicating JSON", () => {
  assert.equal(formatReportText(report), "Telemetry report: 1 metric(s); 1 regression(s), 0 improvement(s), 0 insufficient-data.");
  assert.equal(formatQueryText([{}], 2), "Telemetry query: 1 metric summary(s); 2 event(s) included.");
});
