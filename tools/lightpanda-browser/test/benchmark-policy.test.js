import test from "node:test";
import assert from "node:assert/strict";
import { benchmarkEngines, benchmarkFixtures, benchmarkLimits, contentMatchesFixture, validateBenchmarkPolicy } from "../benchmark-policy.js";

test("benchmark is fixed, bounded, reproducible, and anonymous", () => {
  assert.equal(validateBenchmarkPolicy(), true);
  assert.equal(benchmarkFixtures.length, 3);
  assert.equal(benchmarkLimits.runsPerPage, 1);
  assert.equal(benchmarkLimits.timeoutMs, 30_000);
  assert.deepEqual(benchmarkEngines, ["web-browser", "lightpanda", "chromium"]);
  for (const fixture of benchmarkFixtures) {
    const url = new URL(fixture.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.ok(fixture.requiredText.length > 0);
  }
});

test("benchmark success requires semantic fixture content", () => {
  const fixture = benchmarkFixtures.find((entry) => entry.id === "javascript");
  assert.equal(contentMatchesFixture(fixture, "Amiibo Character Animal Crossing"), false);
  assert.equal(contentMatchesFixture(fixture, "Sandy — Animal Crossing — Isabelle"), true);
});

test("ordinary benchmark excludes Chromium unless explicitly requested", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../scripts/benchmark.js", import.meta.url), "utf8"));
  assert.match(source, /INCLUDE_CHROMIUM/);
  assert.match(source, /includeChromium \? await findChromium\(\) : ""/);
  assert.match(source, /Chromium excluded by default/);
});
