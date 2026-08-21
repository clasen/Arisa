import assert from "node:assert/strict";
import test from "node:test";
import {
  semanticCandidatesWithFallback,
  withSemanticSearchDeadline
} from "../semantic-search.js";

test("semantic search rejects on its internal deadline", async () => {
  await assert.rejects(
    withSemanticSearchDeadline(() => new Promise(() => {}), 20),
    (error) => error.code === "SEMANTIC_SEARCH_TIMEOUT"
      && error.message === "Semantic search timed out after 20ms"
  );
});

test("a timed-out ready index returns empty semantic candidates for lexical fallback", async () => {
  const startedAt = Date.now();
  const result = await semanticCandidatesWithFallback({
    status: "ready",
    statusError: null,
    timeoutMs: 20,
    search: () => new Promise(() => {})
  });

  assert.deepEqual(result.semantic, { indexed: 0, matches: [] });
  assert.equal(result.semanticError, "Semantic search timed out after 20ms");
  assert.ok(Date.now() - startedAt < 250);
});

test("warming and degraded indexes skip semantic work immediately", async () => {
  let searches = 0;
  const search = async () => {
    searches += 1;
    return { indexed: 1, matches: [{ id: "unexpected" }] };
  };

  const warming = await semanticCandidatesWithFallback({ status: "warming", timeoutMs: 20, search });
  const degraded = await semanticCandidatesWithFallback({
    status: "degraded",
    statusError: "model unavailable",
    timeoutMs: 20,
    search
  });

  assert.deepEqual(warming, {
    semantic: { indexed: 0, matches: [] },
    semanticError: null
  });
  assert.deepEqual(degraded, {
    semantic: { indexed: 0, matches: [] },
    semanticError: "model unavailable"
  });
  assert.equal(searches, 0);
});
