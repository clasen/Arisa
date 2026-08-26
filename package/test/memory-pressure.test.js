import assert from "node:assert/strict";
import test from "node:test";
import { memoryPressureReason, readMemoryPressure } from "../src/core/tools/memory-pressure.js";

test("reads Linux available memory, swap pressure, and worker RSS", async () => {
  const snapshot = await readMemoryPressure({
    platform: "linux",
    readMemInfo: async () => [
      "MemTotal:        1000000 kB",
      "MemAvailable:     200000 kB",
      "SwapTotal:        500000 kB",
      "SwapFree:         100000 kB"
    ].join("\n"),
    freeMemory: () => 1,
    totalMemory: () => 2,
    processMemory: () => ({ rss: 123 * 1024 * 1024 })
  });

  assert.equal(snapshot.availableBytes, 200_000 * 1024);
  assert.equal(snapshot.swapUsedPercent, 80);
  assert.equal(snapshot.workerRssBytes, 123 * 1024 * 1024);
});

test("classifies each configured memory pressure boundary", () => {
  const policy = { minAvailableMemoryMb: 128, maxWorkerRssMb: 384, maxSwapUsedPercent: 95 };
  assert.match(memoryPressureReason({
    availableBytes: 100 * 1024 * 1024,
    workerRssBytes: 100 * 1024 * 1024,
    swapTotalBytes: 0,
    swapUsedPercent: 0
  }, policy), /available memory/);
  assert.match(memoryPressureReason({
    availableBytes: 200 * 1024 * 1024,
    workerRssBytes: 400 * 1024 * 1024,
    swapTotalBytes: 0,
    swapUsedPercent: 0
  }, policy), /worker RSS/);
  assert.match(memoryPressureReason({
    availableBytes: 200 * 1024 * 1024,
    workerRssBytes: 100 * 1024 * 1024,
    swapTotalBytes: 100,
    swapUsedPercent: 96
  }, policy), /swap use/);
});
