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
      }
    );
  }
  return records;
}

export async function recordCampaignTelemetry({ arisa, request, output, elapsedMs, status = "ok", enabled = true, telemetryTool = "telemetry-ledger" }) {
  if (!enabled || !telemetryTool) return { recorded: false, reason: "disabled" };
  const records = buildCampaignTelemetryRecords({ request, output, elapsedMs, status });
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
