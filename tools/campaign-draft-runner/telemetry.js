const explorationMetricDefinitions = [
  {
    metric: "campaign.exploration.review_yield",
    kind: "gauge",
    unit: "draft_per_review",
    direction: "higher",
    description: "Confirmed drafts produced by one full campaign review, grouped by bounded exploration strategy",
    dimensions: ["campaign", "strategy", "outcome"]
  },
  {
    metric: "campaign.exploration.candidates_found",
    kind: "counter",
    unit: "candidate",
    direction: "higher",
    description: "Eligible candidates found during one full campaign review",
    dimensions: ["campaign", "strategy", "outcome"]
  },
  {
    metric: "campaign.exploration.full_reviews",
    kind: "counter",
    unit: "review",
    direction: "neutral",
    description: "Full campaign reviews, excluding unchanged-state skips",
    dimensions: ["campaign", "strategy", "outcome"]
  },
  {
    metric: "campaign.exploration.cycles",
    kind: "counter",
    unit: "cycle",
    direction: "neutral",
    description: "Campaign cycles grouped by bounded exploration strategy, including unchanged-state skips",
    dimensions: ["campaign", "strategy", "outcome"]
  }
];

export function classifyExplorationStrategy(output = {}) {
  if (output.skippedUnchanged === true) return "unchanged-skip";
  if (Number(output.creativeDiscovery?.searches || 0) > 0) return "creative-discovery";
  if (Number(output.discovery?.searches || 0) > 0) return "standard-discovery";
  return "existing-pool";
}

function explorationOutcome(output = {}) {
  if (output.skippedUnchanged === true) return "skipped";
  if (Number(output.drafted || 0) > 0) return "drafted";
  if (Number(output.discovery?.found || 0) + Number(output.creativeDiscovery?.found || 0) > 0) return "candidate-only";
  return "zero-result";
}

export function buildCampaignTelemetryRecords({ request, output, elapsedMs, status }) {
  const action = String(request.args?.action || "run-batch");
  const campaign = String(output?.profile || request.args?.profile || "default");
  const records = [{
    metric: "tool.latency_ms",
    kind: "duration",
    value: elapsedMs,
    unit: "ms",
    source: "campaign-draft-runner",
    dimensions: { tool: "campaign-draft-runner", action, status }
  }];
  if (output?.action === "run-batch" && output.dryRun !== true) {
    const strategy = classifyExplorationStrategy(output);
    const outcome = explorationOutcome(output);
    const candidatesFound = Number(output.discovery?.found || 0) + Number(output.creativeDiscovery?.found || 0);
    records.push(
      {
        metric: "campaign.batch.duration_ms",
        kind: "duration",
        value: elapsedMs,
        unit: "ms",
        source: "campaign-draft-runner",
        dimensions: { campaign, status }
      },
      {
        metric: "campaign.batch.drafts_created",
        kind: "counter",
        value: Number(output.drafted || 0),
        unit: "draft",
        source: "campaign-draft-runner",
        dimensions: { campaign, status }
      },
      {
        metric: "gmail.drafts.created",
        kind: "counter",
        value: Number(output.drafted || 0),
        unit: "draft",
        source: "campaign-draft-runner",
        dimensions: { producer: "campaign-draft-runner", campaign, draft_type: "campaign" }
      },
      {
        metric: "campaign.batch.skipped_unchanged",
        kind: "counter",
        value: output.skippedUnchanged === true ? 1 : 0,
        unit: "batch",
        source: "campaign-draft-runner",
        dimensions: { campaign, status }
      }
    );
    const dimensions = { campaign, strategy, outcome };
    records.push({
      metric: "campaign.exploration.cycles",
      kind: "counter",
      value: 1,
      unit: "cycle",
      source: "campaign-draft-runner",
      dimensions
    });
    if (output.skippedUnchanged !== true) {
      records.push(
        {
          metric: "campaign.exploration.review_yield",
          kind: "gauge",
          value: Number(output.drafted || 0),
          unit: "draft_per_review",
          source: "campaign-draft-runner",
          dimensions
        },
        {
          metric: "campaign.exploration.candidates_found",
          kind: "counter",
          value: candidatesFound,
          unit: "candidate",
          source: "campaign-draft-runner",
          dimensions
        },
        {
          metric: "campaign.exploration.full_reviews",
          kind: "counter",
          value: 1,
          unit: "review",
          source: "campaign-draft-runner",
          dimensions
        }
      );
    }
  }
  return records;
}

export async function recordCampaignTelemetry({ arisa, request, output, elapsedMs, status = "ok", enabled = true, telemetryTool = "telemetry-ledger" }) {
  if (!enabled || !telemetryTool) return { recorded: false, reason: "disabled" };
  const records = buildCampaignTelemetryRecords({ request, output, elapsedMs, status });
  if (records.some((record) => record.metric.startsWith("campaign.exploration."))) {
    try {
      await arisa.tools.run({
        name: telemetryTool,
        args: { action: "define", definitions: JSON.stringify(explorationMetricDefinitions) }
      }, { timeoutMs: 10_000 });
    } catch {
      // Recording remains fail-open; an older ledger can still accept undeclared metrics.
    }
  }
  try {
    const result = await arisa.tools.run({
      name: telemetryTool,
      args: { action: "record", records: JSON.stringify(records) }
    }, { timeoutMs: 10_000 });
    return result.ok ? { recorded: true, count: records.length } : { recorded: false, reason: result.error || "telemetry failed" };
  } catch (error) {
    return { recorded: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
