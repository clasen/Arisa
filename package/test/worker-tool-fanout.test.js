import assert from "node:assert/strict";
import test from "node:test";
import { WorkerToolFanoutController } from "../src/core/agent/worker-tool-fanout.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function breaker(percent = 20) {
  return {
    sample: () => ({ heapUsed: percent, heapLimit: 100, percent }),
    admit: async () => ({ heapUsed: percent, heapLimit: 100, percent })
  };
}

test("admits low-pressure tool calls in pairs", async () => {
  const controller = new WorkerToolFanoutController({ heapCircuitBreaker: breaker() });
  const gates = Array.from({ length: 4 }, deferred);
  let active = 0;
  let peak = 0;
  const runs = gates.map((gate) => controller.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await gate.promise;
    active -= 1;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  gates[0].resolve();
  gates[1].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  gates[2].resolve();
  gates[3].resolve();
  await Promise.all(runs);

  assert.equal(peak, 2);
  assert.equal(controller.getDiagnostic().peakQueued, 3);
});

test("serializes tool calls when the worker heap is elevated", async () => {
  const controller = new WorkerToolFanoutController({ heapCircuitBreaker: breaker(70) });
  const gates = Array.from({ length: 3 }, deferred);
  let active = 0;
  let peak = 0;
  const runs = gates.map((gate) => controller.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await gate.promise;
    active -= 1;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  for (const gate of gates) {
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(runs);

  assert.equal(peak, 1);
  assert.ok(controller.getDiagnostic().pressureSerializations > 0);
});

test("rejects a queued tool call when heap admission remains critical", async () => {
  const expected = Object.assign(new Error("critical"), { code: "WORKER_HEAP_PRESSURE" });
  const controller = new WorkerToolFanoutController({
    heapCircuitBreaker: {
      sample: () => ({ heapUsed: 90, heapLimit: 100, percent: 90 }),
      admit: async () => { throw expected; }
    }
  });

  await assert.rejects(controller.run(async () => "unreachable"), expected);
  assert.equal(controller.getDiagnostic().rejectedAdmissions, 1);
});
