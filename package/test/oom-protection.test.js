import assert from "node:assert/strict";
import test from "node:test";
import { protectCoreFromOom } from "../src/runtime/oom-protection.js";

test("lowers Linux core OOM priority when permitted", async () => {
  const writes = [];
  assert.equal(await protectCoreFromOom({
    platform: "linux",
    score: -900,
    writeScore: async (value) => writes.push(value)
  }), true);
  assert.deepEqual(writes, [-900]);
});

test("keeps running when core OOM priority cannot be changed", async () => {
  const logs = [];
  assert.equal(await protectCoreFromOom({
    platform: "linux",
    writeScore: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    logger: { log: (...parts) => logs.push(parts.join(" ")) }
  }), false);
  assert.match(logs.join("\n"), /could not be lowered: EACCES/);
});

test("does not touch OOM controls outside Linux", async () => {
  let called = false;
  assert.equal(await protectCoreFromOom({
    platform: "darwin",
    writeScore: async () => { called = true; }
  }), false);
  assert.equal(called, false);
});
