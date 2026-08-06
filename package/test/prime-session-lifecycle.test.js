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
