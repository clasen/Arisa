import test from "node:test";
import assert from "node:assert/strict";
import { reapObsoleteDaemon } from "../src/runtime/obsolete-daemon-reaper.js";

const record = {
  toolName: "removed-tool",
  instanceId: "global",
  entryPath: "/tools/removed-tool/index.js",
  scope: { type: "global" }
};

test("purges an obsolete daemon with no live process", async () => {
  const purged = [];
  const result = await reapObsoleteDaemon({
    record,
    diagnostic: { pid: null },
    reason: "tool is no longer installed",
    purgeDaemon: async (identity) => purged.push(identity)
  });

  assert.equal(result.outcome, "obsolete-removed");
  assert.deepEqual(purged, [{ toolName: "removed-tool", scope: { type: "global" } }]);
});

test("terminates only a verified obsolete daemon process before purging", async () => {
  const stopped = [];
  const purged = [];
  const result = await reapObsoleteDaemon({
    record,
    diagnostic: { pid: 321 },
    reason: "tool is no longer installed",
    timeoutMs: 100,
    stopTimeoutMs: 50,
    inspectProcesses: async () => [{ pid: 321, command: `${process.execPath} ${record.entryPath} daemon` }],
    stopProcess: async (pid, options) => stopped.push([pid, options]),
    purgeDaemon: async (identity) => purged.push(identity)
  });

  assert.equal(result.outcome, "obsolete-removed");
  assert.deepEqual(stopped, [[321, { forceAfterMs: 50 }]]);
  assert.equal(purged.length, 1);
});

test("leaves an unverifiable live PID untouched", async () => {
  let stopped = false;
  let purged = false;
  const result = await reapObsoleteDaemon({
    record,
    diagnostic: { pid: 321 },
    reason: "registered entry does not match the installed tool",
    timeoutMs: 100,
    stopTimeoutMs: 50,
    inspectProcesses: async () => [{ pid: 321, command: "node /some/other/process.js daemon" }],
    stopProcess: async () => { stopped = true; },
    purgeDaemon: async () => { purged = true; }
  });

  assert.equal(result.outcome, "obsolete-unverified");
  assert.equal(stopped, false);
  assert.equal(purged, false);
});
