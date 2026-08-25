import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeToolExecution,
  normalizeToolExecutionPolicy,
  WeightedResourceGovernor
} from "../src/core/tools/weighted-resource-governor.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("normalizes manifest weights and configurable class capacities", () => {
  assert.deepEqual(normalizeToolExecution({ resourceClass: "browser", weight: 2 }), {
    resourceClass: "browser",
    weight: 2,
    deduplicateConcurrent: false
  });
  assert.equal(normalizeToolExecution({
    resourceClass: "orchestrator",
    weight: 1,
    deduplicateConcurrent: true
  }).deduplicateConcurrent, true);
  assert.equal(normalizeToolExecution(undefined), null);
  assert.throws(() => normalizeToolExecution({ resourceClass: "Browser!", weight: 1 }), /Invalid tool execution resource class/);
  assert.throws(() => normalizeToolExecution({ resourceClass: "browser", weight: 0 }), /positive integer/);
  assert.deepEqual(normalizeToolExecutionPolicy({
    defaultCapacity: 3,
    maxQueuedPerClass: 12,
    capacities: { browser: 4 }
  }), {
    defaultCapacity: 3,
    maxQueuedPerClass: 12,
    capacities: { browser: 4 }
  });
});

test("queues weighted work fairly within one resource class", async () => {
  let time = 100;
  const governor = new WeightedResourceGovernor({
    policy: { defaultCapacity: 2 },
    now: () => time,
    memoryUsage: () => ({ rss: 100 * 1024 * 1024 })
  });
  const execution = { resourceClass: "browser", weight: 1 };
  const first = await governor.acquire(execution, "first");
  const second = await governor.acquire(execution, "second");
  const thirdLease = governor.acquire(execution, "third");
  const fourthLease = governor.acquire(execution, "fourth");

  assert.deepEqual(governor.snapshot().resources.browser, {
    capacity: 2,
    activeWeight: 2,
    queued: 2
  });

  const thirdGranted = deferred();
  thirdLease.then((lease) => thirdGranted.resolve(lease));
  time = 140;
  first.release();
  const third = await thirdGranted.promise;
  assert.equal(third.waitedMs, 40);
  assert.equal(governor.snapshot().resources.browser.queued, 1);

  second.release();
  const fourth = await fourthLease;
  assert.equal(fourth.waitedMs, 40);
  third.release();
  fourth.release();
  assert.equal(governor.snapshot().resources.browser.activeWeight, 0);
});

test("undeclared lightweight work bypasses constrained resource queues", async () => {
  const governor = new WeightedResourceGovernor({ policy: { defaultCapacity: 1 } });
  const heavy = await governor.acquire({ resourceClass: "browser", weight: 1 }, "heavy");
  const queued = governor.acquire({ resourceClass: "browser", weight: 1 }, "queued");
  const light = await governor.acquire(null, "light");
  assert.equal(light.waitedMs, 0);
  assert.equal(governor.snapshot().resources.browser.queued, 1);
  light.release();
  heavy.release();
  (await queued).release();
});

test("larger weights consume shared capacity and worker RSS peaks are retained", async () => {
  let rss = 120 * 1024 * 1024;
  const governor = new WeightedResourceGovernor({
    policy: { defaultCapacity: 3 },
    memoryUsage: () => ({ rss })
  });
  const large = await governor.acquire({ resourceClass: "browser", weight: 2 }, "large");
  const waiting = governor.acquire({ resourceClass: "browser", weight: 2 }, "waiting");
  assert.equal(governor.snapshot().resources.browser.queued, 1);
  rss = 180 * 1024 * 1024;
  large.release();
  const next = await waiting;
  assert.equal(governor.snapshot().peakRssBytes, rss);
  next.release();
});
