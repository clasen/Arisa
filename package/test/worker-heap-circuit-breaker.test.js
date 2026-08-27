import assert from "node:assert/strict";
import test from "node:test";
import {
  readWorkerHeapPressure,
  WorkerHeapCircuitBreaker,
  WorkerHeapPressureError
} from "../src/core/agent/worker-heap-circuit-breaker.js";

function pressure(percent) {
  return { heapUsed: percent, heapLimit: 100, percent };
}

test("reports bounded worker heap pressure", () => {
  assert.deepEqual(readWorkerHeapPressure({
    memoryUsage: () => ({ heapUsed: 40 }),
    heapStatistics: () => ({ heap_size_limit: 100 })
  }), pressure(40));
});

test("evicts inactive sessions under soft pressure and admits recovered work", async () => {
  const samples = [pressure(75), pressure(60)];
  let evictions = 0;
  const breaker = new WorkerHeapCircuitBreaker({
    lifecycle: { async evictInactive() { evictions += 1; return [{ sessionKey: "idle" }]; } },
    measure: () => samples.shift() || pressure(60)
  });

  assert.deepEqual(await breaker.admit(), pressure(60));
  assert.equal(evictions, 1);
  assert.deepEqual(breaker.getDiagnostic(), {
    enabled: true,
    softPercent: 70,
    criticalPercent: 82,
    waitMs: 15_000,
    pollMs: 500,
    heapUsed: 60,
    heapLimit: 100,
    currentHeapPercent: 60,
    pressureEvents: 1,
    evictedSessions: 1,
    delayedAdmissions: 0,
    rejectedAdmissions: 0,
    peakHeapPercent: 75
  });
});

test("delays critical admissions until active work releases memory", async () => {
  const samples = [pressure(90), pressure(89), pressure(78)];
  let now = 0;
  const breaker = new WorkerHeapCircuitBreaker({
    lifecycle: { async evictInactive() { return []; } },
    config: { waitMs: 1_000, pollMs: 100 },
    measure: () => samples.shift() || pressure(78),
    now: () => now,
    sleep: async (ms) => { now += ms; }
  });

  assert.deepEqual(await breaker.admit(), pressure(78));
  assert.equal(breaker.getDiagnostic().delayedAdmissions, 1);
});

test("rejects persistent critical pressure with a retryable error", async () => {
  let now = 0;
  const breaker = new WorkerHeapCircuitBreaker({
    lifecycle: { async evictInactive() { return []; } },
    config: { waitMs: 200, pollMs: 100 },
    measure: () => pressure(90),
    now: () => now,
    sleep: async (ms) => { now += ms; }
  });

  await assert.rejects(
    breaker.admit(),
    (error) => error instanceof WorkerHeapPressureError
      && error.code === "WORKER_HEAP_PRESSURE"
      && error.retryable === true
  );
  assert.equal(breaker.getDiagnostic().rejectedAdmissions, 1);
});
