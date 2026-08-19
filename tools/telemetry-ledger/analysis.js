import { compareSummaries, summarizeEvents } from "./stats.js";

export function filterEvents(events, { metrics = [], dimensions = {} } = {}) {
  return events.filter((event) => {
    if (metrics.length && !metrics.some((metric) => event.metric === metric || (metric.endsWith(".*") && event.metric.startsWith(metric.slice(0, -1))))) return false;
    return Object.entries(dimensions).every(([key, value]) => String(event.dimensions?.[key]) === String(value));
  });
}

export function summarizeByMetric(events, definitions) {
  const groups = new Map();
  for (const event of events) {
    const list = groups.get(event.metric) || [];
    list.push(event);
    groups.set(event.metric, list);
  }
  return [...groups.entries()].map(([metric, items]) => summarizeEvents(items, definitions[metric] || { metric }));
}

export function compareWindows({ baselineEvents, currentEvents, definitions, thresholdPercent, minimumSamples, groupBy = [] }) {
  const metrics = [...new Set([...baselineEvents, ...currentEvents].map((event) => event.metric))].sort();
  const comparisons = metrics.map((metric) => compareSummaries({
    baseline: summarizeEvents(baselineEvents.filter((event) => event.metric === metric), definitions[metric] || { metric }),
    current: summarizeEvents(currentEvents.filter((event) => event.metric === metric), definitions[metric] || { metric }),
    thresholdPercent,
    minimumSamples
  }));
  const hypotheses = [];
  for (const comparison of comparisons.filter((item) => item.status === "regression")) {
    for (const dimension of groupBy) {
      const values = new Set([...baselineEvents, ...currentEvents]
        .filter((event) => event.metric === comparison.current.metric && event.dimensions?.[dimension] !== undefined)
        .map((event) => String(event.dimensions[dimension])));
      for (const value of values) {
        const scopedBaseline = baselineEvents.filter((event) => event.metric === comparison.current.metric && String(event.dimensions?.[dimension]) === value);
        const scopedCurrent = currentEvents.filter((event) => event.metric === comparison.current.metric && String(event.dimensions?.[dimension]) === value);
        const scoped = compareSummaries({
          baseline: summarizeEvents(scopedBaseline, definitions[comparison.current.metric] || {}),
          current: summarizeEvents(scopedCurrent, definitions[comparison.current.metric] || {}),
          thresholdPercent,
          minimumSamples
        });
        if (scoped.status === "regression") hypotheses.push({
          metric: comparison.current.metric,
          dimension,
          value,
          deltaPercent: scoped.deltaPercent,
          baselineSamples: scoped.baseline.samples,
          currentSamples: scoped.current.samples,
          note: "Correlated segment, not a proven cause."
        });
      }
    }
  }
  hypotheses.sort((a, b) => Math.abs(b.deltaPercent) - Math.abs(a.deltaPercent));
  return { comparisons, hypotheses: hypotheses.slice(0, 20) };
}
