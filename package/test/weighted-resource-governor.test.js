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

const safeMemoryPressure = async () => ({
  availableBytes: 512 * 1024 * 1024,
  totalBytes: 4 * 1024 * 1024 * 1024,
  workerRssBytes: 100 * 1024 * 1024,
  swapTotalBytes: 1024,
  swapUsedPercent: 50
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("normalizes manifest weights and configurable class capacities", () => {
  assert.deepEqual(normalizeToolExecution({ resourceClass: "browser", weight: 2 }), {
    resourceClass: "browser",
    weight: 2,
    deduplicateConcurrent: false,
    maxHeapMb: 4096,
    maxMemoryMb: 16_384,
    maxOutputBytes: 1_048_576
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
    maxWorkerRssMb: 384,
    maxSwapUsedPercent: 95,
    initialToolMemoryMb: 384,
    minimumToolMemoryMb: 128,
    maximumToolMemoryMb: 4096,
    systemReserveMb: 128,
    coreReserveMb: 384,
    toolHeapPercent: 65,
    toolMemoryHighPercent: 85,
    toolSwapMaxMb: 128,
    capacities: { browser: 4 }
  });
});

test("queues weighted work fairly within one resource class", async () => {
  let time = 100;
  const governor = new WeightedResourceGovernor({
    policy: { defaultCapacity: 2 },
    now: () => time,
    memoryUsage: () => ({ rss: 100 * 1024 * 1024 }),
    memoryPressure: safeMemoryPressure
  });
  const execution = { resourceClass: "browser", weight: 1 };
  const first = await governor.acquire(execution, "first");
  const second = await governor.acquire(execution, "second");
  const thirdLease = governor.acquire(execution, "third");
  const fourthLease = governor.acquire(execution, "fourth");
  await settle();

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

test("undeclared work bypasses the optional resource governor", async () => {
  const governor = new WeightedResourceGovernor({ policy: { defaultCapacity: 1 }, memoryPressure: safeMemoryPressure });
  const heavy = await governor.acquire({ resourceClass: "browser", weight: 1 }, "heavy");
  const queued = governor.acquire({ resourceClass: "browser", weight: 1 }, "queued");
  await settle();
  const light = await governor.acquire(null, "light");
  assert.equal(light.waitedMs, 0);
  assert.equal(light.memoryLimitMb, undefined);
  assert.equal(light.heapLimitMb, undefined);
  assert.equal(governor.snapshot().resources.browser.queued, 1);
  light.release();
  heavy.release();
  (await queued).release();
});

test("rejects declared heavy tools before spawn when memory pressure is unsafe", async () => {
  const logs = [];
  const governor = new WeightedResourceGovernor({
    policy: { maxWorkerRssMb: 384, maxSwapUsedPercent: 95 },
    memoryPressure: async () => ({
      availableBytes: 80 * 1024 * 1024,
      workerRssBytes: 400 * 1024 * 1024,
      swapTotalBytes: 1024,
      swapUsedPercent: 50
    }),
    logger: { log: (...parts) => logs.push(parts.join(" ")) }
  });

  await assert.rejects(
    () => governor.acquire({ resourceClass: "browser", weight: 1 }, "web-browser"),
    (error) => error.code === "TOOL_RESOURCE_PRESSURE" && /was not started/.test(error.message)
  );
  assert.match(logs.join("\n"), /web-browser rejected for browser/);
  assert.equal(governor.snapshot().resources.browser.activeWeight, 0);
});

test("larger weights consume shared capacity and worker RSS peaks are retained", async () => {
  let rss = 120 * 1024 * 1024;
  const governor = new WeightedResourceGovernor({
    policy: { defaultCapacity: 3 },
    memoryUsage: () => ({ rss }),
    memoryPressure: safeMemoryPressure
  });
  const large = await governor.acquire({ resourceClass: "browser", weight: 2 }, "large");
  const waiting = governor.acquire({ resourceClass: "browser", weight: 2 }, "waiting");
  await settle();
  assert.equal(governor.snapshot().resources.browser.queued, 1);
  rss = 180 * 1024 * 1024;
  large.release();
  const next = await waiting;
  assert.equal(governor.snapshot().peakRssBytes, rss);
  next.release();
});

test("shares one host memory budget across independent resource classes", async () => {
  const pressure = async () => ({
    availableBytes: 512 * 1024 * 1024,
    totalBytes: 1024 * 1024 * 1024,
    workerRssBytes: 100 * 1024 * 1024,
    swapTotalBytes: 0,
    swapUsedPercent: 0
  });
  const governor = new WeightedResourceGovernor({
    policy: { systemReserveMb: 128, coreReserveMb: 384, initialToolMemoryMb: 384 },
    memoryPressure: pressure
  });
  const browser = await governor.acquire({ resourceClass: "browser" }, "browser");
  const queued = governor.acquire({ resourceClass: "orchestrator" }, "orchestrator");
  await settle();

  assert.equal(governor.snapshot().memory.budgetMb, 512);
  assert.equal(governor.snapshot().memory.activeMb, 384);
  assert.equal(governor.snapshot().resources.orchestrator.queued, 1);

  browser.release({ success: true });
  const orchestrator = await queued;
  assert.equal(orchestrator.memoryLimitMb, 384);
  orchestrator.release({ success: true });
});

test("raises a tool memory recommendation after an isolated limit failure", async () => {
  const governor = new WeightedResourceGovernor({
    policy: { initialToolMemoryMb: 256 },
    memoryPressure: safeMemoryPressure
  });
  const first = await governor.acquire({}, "growing-tool");
  assert.equal(first.memoryLimitMb, 256);
  first.release({ memoryLimited: true });

  const second = await governor.acquire({}, "growing-tool");
  assert.equal(second.memoryLimitMb, 384);
  assert.equal(governor.snapshot().memory.profiles["growing-tool"].memoryLimitFailures, 1);
  second.release({ success: true });
});
