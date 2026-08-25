import assert from "node:assert/strict";
import test from "node:test";
import { bindBatchCancellation } from "../batch-cancellation.js";

test("runtime cancellation cancels only the matching Slave batch", () => {
  const calls = [];
  const controller = new AbortController();
  const cleanup = bindBatchCancellation({ cancel: (batchId) => calls.push(batchId) }, "batch-1", controller.signal);

  controller.abort();
  cleanup();
  assert.deepEqual(calls, ["batch-1"]);
});

test("an already aborted runtime signal cancels before batch execution", () => {
  const calls = [];
  const controller = new AbortController();
  controller.abort();

  bindBatchCancellation({ cancel: (batchId) => calls.push(batchId) }, "batch-2", controller.signal)();
  assert.deepEqual(calls, ["batch-2"]);
});
