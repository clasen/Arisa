function quantile(sorted, percentile) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function summarizeEvents(events, definition = {}) {
  const values = events.map((event) => Number(event.value)).filter(Number.isFinite).sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  const spanHours = events.length > 1
    ? Math.max(1 / 3600, (new Date(events.at(-1).timestamp) - new Date(events[0].timestamp)) / 3600000)
    : null;
  return {
    metric: events[0]?.metric || definition.metric || "",
    kind: definition.kind || events[0]?.kind || "gauge",
    unit: definition.unit || events[0]?.unit || "",
    direction: definition.direction || "neutral",
    samples: values.length,
    sum,
    average: values.length ? sum / values.length : null,
    min: values.length ? values[0] : null,
    max: values.length ? values.at(-1) : null,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    ratePerHour: spanHours ? sum / spanHours : null,
    firstAt: events[0]?.timestamp || null,
    lastAt: events.at(-1)?.timestamp || null
  };
}

export function primaryValue(summary) {
  if (["counter", "event"].includes(summary.kind)) return summary.sum;
  return summary.average;
}

export function compareSummaries({ baseline, current, thresholdPercent = 10, minimumSamples = 3 }) {
  const baselineValue = primaryValue(baseline);
  const currentValue = primaryValue(current);
  const delta = baselineValue === null || currentValue === null ? null : currentValue - baselineValue;
  const deltaPercent = delta === null || baselineValue === 0 ? null : delta / Math.abs(baselineValue) * 100;
  let status = "insufficient-data";
  if (baseline.samples >= minimumSamples && current.samples >= minimumSamples && deltaPercent !== null) {
    const magnitude = Math.abs(deltaPercent);
    if (magnitude < thresholdPercent) status = "stable";
    else if (current.direction === "lower") status = delta > 0 ? "regression" : "improvement";
    else if (current.direction === "higher") status = delta < 0 ? "regression" : "improvement";
    else status = "changed";
  }
  return { status, baselineValue, currentValue, delta, deltaPercent, baseline, current };
}
