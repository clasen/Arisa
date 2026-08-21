function finite(value) {
  return Number.isFinite(value) ? value : null;
}

export function compactComparison(item) {
  return {
    metric: item.current?.metric || item.baseline?.metric || "unknown",
    status: item.status,
    baselineValue: finite(item.baselineValue),
    currentValue: finite(item.currentValue),
    delta: finite(item.delta),
    deltaPercent: finite(item.deltaPercent),
    baselineSamples: Number(item.baseline?.samples || 0),
    currentSamples: Number(item.current?.samples || 0),
    baselineP95: finite(item.baseline?.p95),
    currentP95: finite(item.current?.p95)
  };
}

export function compactReport(report) {
  return {
    baseline: report.baseline,
    current: report.current,
    comparisons: report.comparisons.map(compactComparison),
    hypotheses: report.hypotheses
  };
}

export function formatReportText(report) {
  const comparisons = report.comparisons || [];
  const regressions = comparisons.filter((item) => item.status === "regression").length;
  const improvements = comparisons.filter((item) => item.status === "improvement").length;
  const insufficient = comparisons.filter((item) => item.status === "insufficient-data").length;
  return `Telemetry report: ${comparisons.length} metric(s); ${regressions} regression(s), ${improvements} improvement(s), ${insufficient} insufficient-data.`;
}

export function formatQueryText(summaries, eventCount = 0) {
  return `Telemetry query: ${summaries.length} metric summary(s)${eventCount ? `; ${eventCount} event(s) included` : ""}.`;
}
