import assert from "node:assert/strict";
import test from "node:test";
import { restartService, waitForServiceStop } from "../src/runtime/service-manager.js";

test("waits until the stopped service releases its PID before restarting", async () => {
  const calls = [];
  const statuses = [
    { running: true, pid: 41 },
    { running: true, pid: 41 },
    { running: false, pid: null }
  ];

  const result = await restartService({
    verbose: false,
    cliArgs: ["--prime.model", "example/model"],
    shutdownTimeoutMs: 1_000,
    shutdownPollIntervalMs: 1
  }, {
    stop: async () => {
      calls.push("stop");
      return { ok: true, pid: 41 };
    },
    getStatus: async () => {
      calls.push("status");
      return statuses.shift();
    },
    start: async (options) => {
      calls.push("start");
      assert.deepEqual(options, {
        verbose: false,
        cliArgs: ["--prime.model", "example/model"]
      });
      return { ok: true, pid: 84, logFile: "/tmp/arisa.log" };
    },
    sleep: async () => {
      calls.push("sleep");
    }
  });

  assert.deepEqual(calls, ["stop", "status", "sleep", "status", "sleep", "status", "start"]);
  assert.deepEqual(result, {
    ok: true,
    pid: 84,
    previousPid: 41,
    wasRunning: true,
    logFile: "/tmp/arisa.log"
  });
});

test("restart starts Arisa when it is not running", async () => {
  let statusChecks = 0;
  const result = await restartService({
    shutdownTimeoutMs: 1_000,
    shutdownPollIntervalMs: 1
  }, {
    stop: async () => ({ ok: false, reason: "not-running", pid: null }),
    getStatus: async () => {
      statusChecks += 1;
      return { running: false, pid: null };
    },
    start: async () => ({ ok: true, pid: 84, logFile: "/tmp/arisa.log" })
  });

  assert.equal(statusChecks, 0);
  assert.deepEqual(result, {
    ok: true,
    pid: 84,
    previousPid: null,
    wasRunning: false,
    logFile: "/tmp/arisa.log"
  });
});

test("restart does not start a second service when shutdown times out", async () => {
  let started = false;

  await assert.rejects(
    restartService({
      shutdownTimeoutMs: 2,
      shutdownPollIntervalMs: 1
    }, {
      stop: async () => ({ ok: true, pid: 41 }),
      getStatus: async () => ({ running: true, pid: 41 }),
      start: async () => {
        started = true;
        return { ok: true, pid: 84 };
      },
      sleep: async () => {}
    }),
    /did not stop within 2ms/
  );

  assert.equal(started, false);
});

test("requires explicit positive shutdown timing policy", async () => {
  await assert.rejects(
    waitForServiceStop({ timeoutMs: 0, pollIntervalMs: 1 }),
    /positive shutdownTimeoutMs/
  );
  await assert.rejects(
    waitForServiceStop({ timeoutMs: 1, pollIntervalMs: 0 }),
    /positive shutdownPollIntervalMs/
  );
});
