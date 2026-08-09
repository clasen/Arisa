import assert from "node:assert/strict";
import test from "node:test";
import { AgentManager } from "../src/core/agent/agent-manager.js";

function createManager() {
  return new AgentManager({
    config: {
      agent: { runtime: "prime" },
      prime: {
        provider: "test",
        model: "model",
        thinkingLevel: "medium"
      }
    }
  });
}

test("shares an in-flight Prime session creation for the same chat", async () => {
  const manager = createManager();
  let releaseCreation;
  const creationGate = new Promise((resolve) => { releaseCreation = resolve; });
  const context = { session: {}, modelKey: "test/model@0" };
  let creationCount = 0;
  manager.createPrimeSessionContext = async () => {
    creationCount += 1;
    await creationGate;
    return context;
  };

  const first = manager.getPrimeSessionContext("42");
  const second = manager.getPrimeSessionContext("42");
  assert.equal(creationCount, 1);

  releaseCreation();
  const [firstContext, secondContext] = await Promise.all([first, second]);
  assert.equal(firstContext, context);
  assert.equal(secondContext, context);
  assert.equal(creationCount, 1);
});

test("waits for a cached Prime session to close before reopening", async () => {
  const manager = createManager();
  let releaseClose;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  let closeStarted = false;
  manager.sessions.set("42", {
    session: {
      close: async () => {
        closeStarted = true;
        await closeGate;
      }
    }
  });

  const closing = manager.closeCachedSession("42");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeStarted, true);
  assert.equal(manager.sessions.has("42"), false);

  let waitFinished = false;
  const waiting = manager.waitForSessionClose("42").then(() => { waitFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waitFinished, false);

  releaseClose();
  await Promise.all([closing, waiting]);
  assert.equal(waitFinished, true);
});

test("discards a Prime session that finishes starting after /new", async () => {
  const manager = createManager();
  let releaseCreation;
  const creationGate = new Promise((resolve) => { releaseCreation = resolve; });
  let creationCount = 0;
  let staleCloseCount = 0;
  manager.createPrimeSessionContext = async () => {
    creationCount += 1;
    if (creationCount === 1) await creationGate;
    return {
      session: { close: async () => { staleCloseCount += 1; } },
      modelKey: "test/model@0"
    };
  };

  const staleCreation = manager.getPrimeSessionContext("42");
  manager.resetSession("42");
  const freshCreation = manager.getPrimeSessionContext("42");
  releaseCreation();

  await assert.rejects(staleCreation, /reset during startup/);
  const context = await freshCreation;

  assert.equal(creationCount, 2);
  assert.equal(staleCloseCount, 1);
  assert.equal(context.modelKey, "test/model@0");
});

test("closes active sessions and carries portable handoffs across a runtime switch", async () => {
  const manager = createManager();
  let closeCount = 0;
  manager.sessions.set("42", {
    session: { close: async () => { closeCount += 1; } }
  });
  const config = {
    agent: { runtime: "pi" },
    pi: { provider: "test", model: "model", thinkingLevel: "medium" }
  };

  await manager.switchRuntime(config, {
    handoffs: new Map([["42", "Complete portable history"]])
  });

  assert.equal(closeCount, 1);
  assert.equal(manager.config, config);
  assert.equal(manager.sessions.size, 0);
  assert.equal(manager.pendingNewSessions.has("42"), true);
  assert.deepEqual(manager.pendingSessionHandoffs.get("42"), {
    text: "Complete portable history",
    parentSession: ""
  });
});

test("disposes a cached Pi session during a runtime switch", async () => {
  const manager = createManager();
  let disposeCount = 0;
  manager.sessions.set("42", {
    session: { dispose: () => { disposeCount += 1; } }
  });

  await manager.switchRuntime({
    agent: { runtime: "prime" },
    prime: { provider: "test", model: "model", thinkingLevel: "medium" }
  });

  assert.equal(disposeCount, 1);
});

test("reports only live Prime child processes as managed", () => {
  const manager = createManager();
  manager.sessions.set("active", {
    session: { child: { pid: 101, exitCode: null, signalCode: null } }
  });
  manager.sessions.set("closed", {
    session: { child: { pid: 202, exitCode: 0, signalCode: null } }
  });
  manager.pendingPrimeSessions.set("starting", { promise: new Promise(() => {}) });
  manager.sessionClosePromises.set("closing", new Promise(() => {}));

  assert.deepEqual(manager.getRuntimeDiagnostic(), {
    runtime: "prime",
    sessions: 2,
    startingSessions: 1,
    closingSessions: 1,
    managedProcessIds: [101]
  });
});
