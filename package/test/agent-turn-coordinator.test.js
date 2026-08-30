import assert from "node:assert/strict";
import test from "node:test";
import { AgentTurnCoordinator } from "../src/core/agent/agent-turn-coordinator.js";

test("interactive turns run before queued background turns without overlapping", async () => {
  const coordinator = new AgentTurnCoordinator();
  const releaseActive = await coordinator.acquire({ priority: "background", label: "active background" });
  let backgroundStarted = false;
  const background = coordinator.acquire({ priority: "background", label: "queued background" }).then((release) => {
    backgroundStarted = true;
    return release;
  });
  const interactive = coordinator.acquire({ priority: "interactive", label: "interactive" });

  releaseActive();
  const releaseInteractive = await interactive;
  assert.equal(backgroundStarted, false);
  assert.equal(coordinator.diagnostic().active.priority, "interactive");
  releaseInteractive();
  const releaseBackground = await background;
  assert.equal(backgroundStarted, true);
  releaseBackground();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.diagnostic().active, null);
  assert.equal(coordinator.diagnostic().completed, 3);
});

test("background turns expire safely before execution when their queue TTL elapses", async () => {
  const coordinator = new AgentTurnCoordinator();
  const releaseActive = await coordinator.acquire({ priority: "interactive", label: "active" });
  await assert.rejects(
    coordinator.acquire({ priority: "background", label: "stale batch", queueTtlMs: 10 }),
    (error) => error.code === "AGENT_TURN_QUEUE_EXPIRED" && error.retryable === true && error.outcomeUncertain === false
  );
  assert.equal(coordinator.diagnostic().expired, 1);
  releaseActive();
});

test("run releases exclusive admission after failures", async () => {
  const coordinator = new AgentTurnCoordinator();
  await assert.rejects(coordinator.run({ priority: "background" }, async () => { throw new Error("failed"); }), /failed/);
  const result = await coordinator.run({ priority: "interactive" }, async () => "ok");
  assert.equal(result, "ok");
  assert.equal(coordinator.diagnostic().completed, 2);
});
