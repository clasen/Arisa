import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramRestartHandler, telegramCommands } from "../src/transport/telegram/bot.js";
import { handoffServiceRestart, restartService, serviceEntryFile, waitForServiceStop } from "../src/runtime/service-manager.js";

test("registers /restart as a native Telegram command", () => {
  assert.equal(
    telegramCommands.some((command) => command.command === "restart"),
    true
  );
  assert.equal(telegramCommands.some((command) => command.command === "harness"), false);
  assert.equal(telegramCommands.some((command) => command.command === "login"), false);
});

test("replies before handing restart to a detached CLI process", async () => {
  const calls = [];
  let unreferenced = false;
  let logClosed = false;
  const environment = { ARISA_TEST: "restart" };

  const result = await handoffServiceRestart({
    verbose: false,
    cliArgs: ["--pi.model", "example/model"]
  }, {
    ensureHome: async () => { calls.push("ensure-home"); },
    getStatus: async () => {
      calls.push("get-status");
      return { running: true, pid: 41 };
    },
    openLog: async (file, mode) => {
      calls.push(["open-log", file, mode]);
      return {
        fd: 17,
        close: async () => { logClosed = true; }
      };
    },
    spawnProcess: (command, args, options) => {
      calls.push(["spawn", command, args, options]);
      return {
        pid: 84,
        unref: () => { unreferenced = true; }
      };
    },
    environment,
    currentPid: 41
  });

  assert.equal(calls[0], "ensure-home");
  assert.equal(calls[1], "get-status");
  assert.equal(calls[2][0], "open-log");
  assert.equal(calls[2][2], "a");
  assert.equal(calls[3][0], "spawn");
  assert.equal(calls[3][1], process.execPath);
  assert.deepEqual(calls[3][2], [
    serviceEntryFile,
    "restart",
    "--pi.model",
    "example/model",
    "--silent"
  ]);
  assert.deepEqual(calls[3][3], {
    detached: true,
    stdio: ["ignore", 17, 17],
    env: environment
  });
  assert.equal(unreferenced, true);
  assert.equal(logClosed, true);
  assert.equal(result.pid, 84);

  const handlerCalls = [];
  const handler = createTelegramRestartHandler({
    authorize: async () => ({ ok: true }),
    requestRestart: async () => {
      handlerCalls.push("handoff");
      return result;
    }
  });
  const ctx = {
    reply: async (text) => { handlerCalls.push(["reply", text]); }
  };

  await handler(ctx);
  await handler(ctx);

  assert.deepEqual(handlerCalls, [
    ["reply", "Arisa is restarting. I'll be back shortly."],
    "handoff",
    ["reply", "An Arisa restart is already in progress."]
  ]);
});

test("refuses Telegram restart handoff outside the active background service", async () => {
  let spawned = false;

  await assert.rejects(
    handoffServiceRestart({}, {
      ensureHome: async () => {},
      getStatus: async () => ({ running: true, pid: 99 }),
      spawnProcess: () => {
        spawned = true;
      },
      currentPid: 41
    }),
    /requires the active background service process/
  );

  assert.equal(spawned, false);
});

test("reports a failed Telegram restart handoff and permits retry", async () => {
  const replies = [];
  let attempts = 0;
  const handler = createTelegramRestartHandler({
    authorize: async () => ({ ok: true }),
    requestRestart: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("synthetic handoff failure");
      return { pid: 84 };
    }
  });
  const ctx = { reply: async (text) => { replies.push(text); } };

  await handler(ctx);
  await handler(ctx);

  assert.equal(attempts, 2);
  assert.deepEqual(replies, [
    "Arisa is restarting. I'll be back shortly.",
    "Arisa could not be restarted: synthetic handoff failure",
    "Arisa is restarting. I'll be back shortly."
  ]);
});

test("waits until the stopped service releases its PID before restarting", async () => {
  const calls = [];
  const statuses = [
    { running: true, pid: 41 },
    { running: true, pid: 41 },
    { running: false, pid: null }
  ];

  const result = await restartService({
    verbose: false,
    cliArgs: ["--pi.model", "example/model"],
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
        cliArgs: ["--pi.model", "example/model"]
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
