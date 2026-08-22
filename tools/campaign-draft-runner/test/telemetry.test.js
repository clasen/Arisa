import assert from "node:assert/strict";
import test from "node:test";
import { buildCampaignTelemetryRecords, recordCampaignTelemetry } from "../telemetry.js";

test("builds generic latency and confirmed draft telemetry", () => {
  const records = buildCampaignTelemetryRecords({
    request: { args: { action: "run-batch", profile: "castle-bravo" } },
    output: { action: "run-batch", profile: "castle-bravo", dryRun: false, drafted: 2 },
    elapsedMs: 4200,
    status: "ok"
  });
  assert.deepEqual(records.map((record) => [record.metric, record.value]), [
    ["tool.latency_ms", 4200],
    ["campaign.batch.duration_ms", 4200],
    ["campaign.batch.drafts_created", 2],
    ["gmail.drafts.created", 2],
    ["campaign.batch.skipped_unchanged", 0]
  ]);
  assert.equal(records[3].dimensions.campaign, "castle-bravo");
});

test("counts unchanged batches separately from full zero-draft runs", () => {
  const records = buildCampaignTelemetryRecords({
    request: { args: { action: "run-batch", profile: "castle-bravo" } },
    output: { action: "run-batch", profile: "castle-bravo", dryRun: false, drafted: 0, skippedUnchanged: true },
    elapsedMs: 80,
    status: "ok"
  });
  assert.equal(records.find((record) => record.metric === "campaign.batch.skipped_unchanged").value, 1);
});

test("does not count dry-run drafts", () => {
  const records = buildCampaignTelemetryRecords({
    request: { args: { action: "run-batch" } },
    output: { action: "run-batch", dryRun: true, drafted: 1 },
    elapsedMs: 20,
    status: "ok"
  });
  assert.deepEqual(records.map((record) => record.metric), ["tool.latency_ms"]);
});

test("telemetry failure does not alter the campaign outcome", async () => {
  const result = await recordCampaignTelemetry({
    arisa: { tools: { async run() { throw new Error("unavailable"); } } },
    request: { args: { action: "status" } },
    output: { action: "status" },
    elapsedMs: 10
  });
  assert.equal(result.recorded, false);
  assert.match(result.reason, /unavailable/);
});
