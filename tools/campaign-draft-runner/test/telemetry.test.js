import assert from "node:assert/strict";
import test from "node:test";
import { buildCampaignTelemetryRecords, classifyExplorationStrategy, recordCampaignTelemetry } from "../telemetry.js";

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
    ["campaign.batch.skipped_unchanged", 0],
    ["campaign.exploration.cycles", 1],
    ["campaign.exploration.review_yield", 2],
    ["campaign.exploration.candidates_found", 0],
    ["campaign.exploration.full_reviews", 1]
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
  const exploration = records.filter((record) => record.metric.startsWith("campaign.exploration."));
  assert.deepEqual(exploration.map((record) => record.metric), ["campaign.exploration.cycles"]);
  assert.deepEqual(exploration[0].dimensions, {
    campaign: "castle-bravo",
    strategy: "unchanged-skip",
    outcome: "skipped"
  });
});

test("classifies only bounded exploration strategies and records their useful outcome", () => {
  assert.equal(classifyExplorationStrategy({ discovery: { searches: 2 } }), "standard-discovery");
  assert.equal(classifyExplorationStrategy({
    discovery: { searches: 2, found: 0 },
    creativeDiscovery: { searches: 1, found: 1 }
  }), "creative-discovery");
  assert.equal(classifyExplorationStrategy({ drafted: 1 }), "existing-pool");

  const records = buildCampaignTelemetryRecords({
    request: { args: { action: "run-batch", profile: "castle-bravo" } },
    output: {
      action: "run-batch",
      profile: "castle-bravo",
      dryRun: false,
      drafted: 0,
      discovery: { searches: 2, found: 0 },
      creativeDiscovery: { searches: 1, found: 1 }
    },
    elapsedMs: 100,
    status: "ok"
  });
  const metric = records.find((record) => record.metric === "campaign.exploration.candidates_found");
  assert.equal(metric.value, 1);
  assert.deepEqual(metric.dimensions, {
    campaign: "castle-bravo",
    strategy: "creative-discovery",
    outcome: "candidate-only"
  });
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

test("defines exploration metrics before recording them", async () => {
  const actions = [];
  const result = await recordCampaignTelemetry({
    arisa: { tools: { async run(request) { actions.push(request.args.action); return { ok: true }; } } },
    request: { args: { action: "run-batch" } },
    output: { action: "run-batch", dryRun: false, drafted: 0 },
    elapsedMs: 10
  });
  assert.equal(result.recorded, true);
  assert.deepEqual(actions, ["define", "record"]);
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
