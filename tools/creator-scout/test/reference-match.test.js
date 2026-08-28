import test from "node:test";
import assert from "node:assert/strict";
import { exactReferenceMatch, referenceTitles } from "../reference-match.js";

test("matches an exact comparable title inside a video title", () => {
  assert.deepEqual(
    exactReferenceMatch("The Healing | All Endings | Walkthrough", ["The Healing"]),
    { exact: true, matchedTitle: "The Healing" }
  );
});

test("rejects semantically adjacent but different videos", () => {
  assert.equal(exactReferenceMatch("Days Gone Zombies are Scary!", ["The Vigil Files"]).exact, false);
});

test("supports explicit localized aliases", () => {
  assert.equal(exactReferenceMatch("การหายตัวไปของซาร่า | Sara is Missing", ["Sara is Missing", "การหายตัวไปของซาร่า"]).exact, true);
});

test("parses arrays without guessing titles from the search query", () => {
  assert.deepEqual(referenceTitles({ referenceTitles: ["Duskwood", "더스크우드"] }), ["Duskwood", "더스크우드"]);
});

test("parses JSON-encoded title arrays from CLI args", () => {
  assert.deepEqual(referenceTitles({ referenceTitles: '["SIMULACRA", "SIMULACRA 2"]' }), ["SIMULACRA", "SIMULACRA 2"]);
});
