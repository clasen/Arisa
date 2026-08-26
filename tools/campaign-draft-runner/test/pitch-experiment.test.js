import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pitchExperimentSummary, recordPitchAssignment, recordPitchOutcome, selectPitchVariant } from "../pitch-experiment.js";
import { reviewerGuideMarkdown, writeReviewerGuide } from "../reviewer-kit.js";

const profile = {
  name: "castle-bravo",
  pitchExperiment: {
    variants: [{ id: "a" }, { id: "b" }, { id: "c" }]
  }
};

test("pitch assignment is deterministic and uses the configured catalog", () => {
  const first = selectPitchVariant({ email: "reviewer@example.com" }, profile);
  const second = selectPitchVariant({ email: "reviewer@example.com" }, profile);
  assert.equal(first.id, second.id);
  assert.ok(["a", "b", "c"].includes(first.id));
});

test("pitch outcomes produce per-variant experiment metrics", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pitch-experiment-"));
  try {
    await recordPitchAssignment(directory, profile.name, { email: "one@example.com", outlet: "One", variant: "a", draftId: "d1" });
    await recordPitchOutcome(directory, profile.name, { email: "one@example.com", outcome: "coverage" });
    const summary = await pitchExperimentSummary(directory, profile.name, profile.pitchExperiment.variants);
    assert.equal(summary.assignments, 1);
    assert.equal(summary.variants.a.assigned, 1);
    assert.equal(summary.variants.a.sent, 1);
    assert.equal(summary.variants.a.responses, 1);
    assert.equal(summary.variants.a.coverage, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const facts = {
  publicUrl: "https://castlebravo.org/",
  accessAndReview: "Download the published iOS or Android app directly.",
  contentLength: "The complete game lasts approximately three hours.",
  futureStoriesCharacters: "The current game tells one conspiracy story with five characters.",
  platformPricing: "Castle Bravo is free.",
  mobileRequirements: "No exact minimum specification has been approved.",
  companyProfile: "The company is Blyts."
};

test("reviewer guide uses approved facts and generated markdown starts with a UTF-8 BOM", async () => {
  const markdown = reviewerGuideMarkdown(profile, facts);
  assert.match(markdown, /three hours/);
  assert.match(markdown, /owner-supplied source video/);
  const directory = await mkdtemp(path.join(os.tmpdir(), "reviewer-guide-"));
  try {
    const output = await writeReviewerGuide(directory, profile, facts);
    const bytes = await readFile(output.filePath);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
