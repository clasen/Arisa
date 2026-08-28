import test from "node:test";
import assert from "node:assert/strict";
import { applyConfigDefaults } from "../src/core/config/config-defaults.js";
import { AgentManager } from "../src/core/agent/agent-manager.js";
import { compactionRotationRequest, normalizeSessionRotationPolicy } from "../src/core/agent/session-rotation.js";

const mebibyte = 1024 * 1024;

function compactionEvent(summary = "checkpoint") {
  return {
    type: "compaction_end",
    aborted: false,
    errorMessage: "",
    result: { summary }
  };
}

test("normalizes the automatic session rotation policy", () => {
  assert.deepEqual(normalizeSessionRotationPolicy(), {
    enabled: true,
    compactAtPersistedBytes: 24 * mebibyte,
    maxPersistedBytes: 32 * mebibyte
  });
  assert.deepEqual(normalizeSessionRotationPolicy({
    enabled: false,
    compactAtPersistedBytes: 8,
    maxPersistedBytes: 12
  }), {
    enabled: false,
    compactAtPersistedBytes: 8,
    maxPersistedBytes: 12
  });
});

test("requests rotation only after a successful oversized compaction", () => {
  assert.equal(compactionRotationRequest(compactionEvent(), 24 * mebibyte), null);
  assert.equal(compactionRotationRequest({ ...compactionEvent(), aborted: true }, 25 * mebibyte), null);
  assert.equal(compactionRotationRequest(compactionEvent(), 25 * mebibyte, { enabled: false }), null);
  const request = compactionRotationRequest(compactionEvent("latest summary"), 25 * mebibyte);
  assert.equal(request.persistedBytes, 25 * mebibyte);
  assert.match(request.handoff, /latest summary/);
});

test("compacts at the preventive persisted-size threshold and then rotates", async () => {
  const config = applyConfigDefaults({ telegram: {}, pi: { provider: "test", model: "test" } });
  const manager = new AgentManager({
    config,
    artifactStore: {},
    toolRegistry: {},
    taskStore: {},
    logger: null
  });
  let compactions = 0;
  const context = {
    activeUsers: 1,
    session: {
      sessionFile: "/sessions/preventive.jsonl",
      async compact() {
        compactions += 1;
        manager.scheduleCompactionRotationCheck("chat", context, compactionEvent("preventive summary"));
      },
      async close() {}
    },
    rotationCheckPromise: Promise.resolve(),
    rotationRequest: null
  };
  manager.sessions.set("chat", context);
  manager.estimatePersistedSessionBytes = async () => 25 * mebibyte;

  await manager.releaseSessionContext("chat", context);

  assert.equal(compactions, 1);
  assert.equal(manager.sessions.has("chat"), false);
  assert.equal(manager.pendingNewSessions.has("chat"), true);
});

test("rotates after active work releases and preserves the parent session path", async () => {
  const config = applyConfigDefaults({ telegram: {}, pi: { provider: "test", model: "test" } });
  let closes = 0;
  const manager = new AgentManager({
    config,
    artifactStore: {},
    toolRegistry: {},
    taskStore: {},
    logger: null
  });
  const context = {
    activeUsers: 1,
    session: {
      sessionFile: "/sessions/oversized.jsonl",
      async close() { closes += 1; }
    },
    rotationCheckPromise: Promise.resolve(),
    rotationRequest: null
  };
  manager.sessions.set("chat", context);
  manager.estimatePersistedSessionBytes = async () => 65 * mebibyte;

  manager.scheduleCompactionRotationCheck("chat", context, compactionEvent("handoff summary"));
  await manager.releaseSessionContext("chat", context);

  assert.equal(closes, 1);
  assert.equal(manager.sessions.has("chat"), false);
  assert.equal(manager.pendingNewSessions.has("chat"), true);
  assert.deepEqual(manager.pendingSessionHandoffs.get("chat"), {
    text: "Automatic session rotation after compaction. Continue from this checkpoint:\n\nhandoff summary",
    parentSession: "/sessions/oversized.jsonl",
    source: "compaction-rotation"
  });
});
