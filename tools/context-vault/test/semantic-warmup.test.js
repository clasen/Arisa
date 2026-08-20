import assert from "node:assert/strict";
import test from "node:test";
import { SemanticWarmup } from "../semantic-warmup.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("semantic warmup serves as background work and flushes queued mutations", async () => {
  const initialization = deferred();
  const indexed = new Map();
  const semantic = new SemanticWarmup({
    initialize: () => initialization.promise,
    listRecords: async () => [
      { id: "old", text: "old memory" },
      { id: "kept", text: "kept memory" }
    ],
    indexRecord: async (_resources, id, record) => {
      indexed.set(id, record.text);
      return true;
    },
    deleteRecord: async (_resources, id) => indexed.delete(id),
    clear: async () => indexed.clear(),
    dispose: async () => {}
  }).start();

  assert.equal(semantic.status, "warming");
  assert.deepEqual(await semantic.upsert("new", { id: "new", text: "new memory" }), {
    applied: false,
    deferred: true
  });
  assert.deepEqual(await semantic.delete("old"), { applied: false, deferred: true });

  initialization.resolve({ store: {} });
  await semantic.promise;

  assert.equal(semantic.status, "ready");
  assert.deepEqual([...indexed.entries()].sort(), [
    ["kept", "kept memory"],
    ["new", "new memory"]
  ]);
  assert.equal(semantic.snapshot().pending, 0);
});

test("failed semantic warmup degrades without rejecting lexical startup", async () => {
  const semantic = new SemanticWarmup({
    initialize: async () => { throw new Error("model unavailable"); },
    listRecords: async () => [],
    indexRecord: async () => true,
    deleteRecord: async () => true,
    clear: async () => {},
    dispose: async () => {}
  }).start();

  await semantic.promise;

  assert.equal(semantic.status, "degraded");
  assert.equal(semantic.error, "model unavailable");
  assert.equal((await semantic.upsert("later", { id: "later" })).deferred, true);
});
