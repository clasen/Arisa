import test from "node:test";
import assert from "node:assert/strict";
import { contentMatchesLimitFixture, limitFixtures, limitSuiteLimits, validateLimitSuitePolicy } from "../limit-suite-policy.js";

test("limit suite covers representative public categories with semantic assertions", () => {
  assert.equal(validateLimitSuitePolicy(), true);
  assert.deepEqual(new Set(limitFixtures.map((fixture) => fixture.category)), new Set([
    "react", "vue", "angular", "forms", "modals", "tables", "scrolling", "redirects", "iframes"
  ]));
  assert.equal(limitFixtures.every((fixture) => fixture.requiredText.length > 0), true);
  assert.equal(limitSuiteLimits.navigationCount, 100);
  assert.equal(limitSuiteLimits.concurrentSessions, 2);
});

test("fixture success requires every semantic marker and expected final URL", () => {
  const fixture = { requiredText: ["Angular", "Todos"], finalUrl: "https://example.com/" };
  assert.deepEqual(contentMatchesLimitFixture(fixture, "Angular Todos", "https://example.com/"), {
    success: true, missingText: [], finalUrlMatches: true
  });
  assert.equal(contentMatchesLimitFixture(fixture, "Angular", "https://example.com/").success, false);
  assert.equal(contentMatchesLimitFixture(fixture, "Angular Todos", "https://wrong.example/").success, false);
});

test("limit suite implementation never references Chromium", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../scripts/limit-suite.js", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /spawn\([^\n]*chrom/i);
  assert.match(source, /chromiumLaunched: false/);
});
