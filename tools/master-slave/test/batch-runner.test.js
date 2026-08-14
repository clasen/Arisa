import assert from "node:assert/strict";
import test from "node:test";
import { SlaveBatchRunner } from "../batch-runner.js";

function batch(count = 3) {
  return {
    batchId: "batch-1",
    status: "queued",
    jobs: Array.from({ length: count }, (_, index) => ({
      jobId: `job-${index}`,
      batchId: "batch-1",
      slaveId: `slave-${index}`,
      slaveName: `node-${index}`,
      status: "queued"
    }))
  };
}

test("persists accepted before effects and enforces configured concurrency", async () => {
  const snapshots = [];
  let active = 0;
  let maximum = 0;
  const runner = new SlaveBatchRunner({
    concurrency: 2,
    persistBatch: async (value) => snapshots.push(structuredClone(value)),
    executeJob: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { status: "completed" };
    }
  });
  const result = await runner.run(batch());
  assert.equal(maximum, 2);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.summary, {
    batchId: "batch-1",
    completed: 3,
    failed: 0,
    cancelled: 0,
    expired: 0,
    notStarted: 0,
    total: 3
  });
  for (const job of result.jobs) {
    assert.ok(snapshots.some((snapshot) => snapshot.jobs.find((item) => item.jobId === job.jobId)?.status === "accepted"));
  }
});

test("tags interleaved chunks with the correct Slave and sequence", async () => {
  const events = [];
  const runner = new SlaveBatchRunner({
    concurrency: 2,
    persistBatch: async () => {},
    onEvent: (event) => events.push(event),
    executeJob: async (job, { onChunk }) => {
      await onChunk({ sequence: 1, data: `${job.slaveId}-one` });
      await onChunk({ sequence: 2, data: `${job.slaveId}-two` });
      return { status: "completed" };
    }
  });
  await runner.run(batch(2));
  assert.deepEqual(events.filter((event) => event.slaveId === "slave-0").map((event) => event.sequence), [1, 2]);
  assert.deepEqual(events.filter((event) => event.slaveId === "slave-1").map((event) => event.sequence), [1, 2]);
  assert.ok(events.every((event) => event.slaveName.startsWith("node-")));
});

test("returns process stdout and stderr in the completed batch", async () => {
  const processBatch = batch(1);
  processBatch.jobs[0].operation = "process.exec";
  const runner = new SlaveBatchRunner({
    concurrency: 1,
    persistBatch: async () => {},
    executeJob: async (_job, { onChunk }) => {
      await onChunk({ sequence: 2, channel: "stderr", data: "warning\n" });
      await onChunk({ sequence: 1, channel: "stdout", data: "first\n" });
      await onChunk({ sequence: 3, channel: "stdout", data: "second\n" });
      return { status: "completed", code: 0, signal: null };
    }
  });

  const result = await runner.run(processBatch);

  assert.deepEqual(result.jobs[0].result, {
    status: "completed",
    code: 0,
    signal: null,
    stdout: "first\nsecond\n",
    stderr: "warning\n"
  });
});

test("cancelling a batch aborts active jobs and never starts pending jobs", async () => {
  const started = [];
  let runner;
  runner = new SlaveBatchRunner({
    concurrency: 1,
    persistBatch: async () => {},
    executeJob: async (job, { signal }) => {
      started.push(job.jobId);
      runner.cancel("batch-1");
      if (signal.aborted) throw new Error("aborted");
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
  });
  const result = await runner.run(batch(3));
  assert.deepEqual(started, ["job-0"]);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.jobs.map((job) => job.status), ["cancelled", "not_started", "not_started"]);
  assert.equal(result.summary.notStarted, 2);
});
