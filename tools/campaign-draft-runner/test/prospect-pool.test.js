import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalEvidenceUrl, listProspects, prospectScore, saveProspect, summarizeProspects, updateProspect } from "../prospect-pool.js";

test("prospect scoring follows the bounded 100-point rubric", () => {
  assert.deepEqual(prospectScore({
    thematicFit: 40,
    recentActivity: 18,
    smallIndieCoverage: 12,
    audienceFit: 14,
    publicContact: 8,
    responseLikelihood: -2
  }), {
    signals: {
      thematicFit: 30,
      recentActivity: 18,
      smallIndieCoverage: 12,
      audienceFit: 14,
      publicContact: 8,
      responseLikelihood: 0
    },
    total: 82
  });
});

test("evidence URLs are canonical and duplicate prospects are not added", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "campaign-prospects-"));
  const input = {
    sourceUrl: "https://example.com/video/?utm_source=x#details",
    name: "Reviewer",
    outlet: "Small Channel",
    segment: "walkthrough-video",
    evidence: "Published a complete narrative mystery walkthrough this month.",
    scoreSignals: { thematicFit: 25, recentActivity: 20, smallIndieCoverage: 12, audienceFit: 12, publicContact: 0, responseLikelihood: 8 }
  };
  try {
    assert.equal(canonicalEvidenceUrl(input.sourceUrl), "https://example.com/video");
    const first = await saveProspect(directory, "castle-bravo", input);
    const duplicate = await saveProspect(directory, "castle-bravo", input);
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await listProspects(directory, "castle-bravo")).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prospects can gain contact evidence and move through the qualification workflow", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "campaign-prospects-"));
  const sourceUrl = "https://example.com/newsletter/post";
  try {
    await saveProspect(directory, "castle-bravo", {
      sourceUrl,
      segment: "podcasts-newsletters-curators",
      evidence: "Covers interactive fiction.",
      scoreSignals: { thematicFit: 20 }
    });
    const updated = await updateProspect(directory, "castle-bravo", {
      sourceUrl,
      status: "qualified",
      contactUrl: "https://example.com/contact",
      scoreSignals: { thematicFit: 30, recentActivity: 20, smallIndieCoverage: 10, audienceFit: 15, publicContact: 10, responseLikelihood: 8 }
    });
    assert.equal(updated.prospect.status, "qualified");
    assert.equal(updated.prospect.score, 93);
    const prospects = await listProspects(directory, "castle-bravo", { minimumScore: 65 });
    assert.equal(prospects.length, 1);
    assert.deepEqual(summarizeProspects(prospects, 40, 65), {
      total: 1,
      storedTotal: 1,
      target: 40,
      remaining: 39,
      qualifiedByScore: 1,
      withPublicContact: 1,
      byStatus: { qualified: 1 },
      bySegment: { "podcasts-newsletters-curators": 1 }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
