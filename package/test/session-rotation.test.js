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
    maxPersistedBytes: 64 * mebibyte
  });
  assert.deepEqual(normalizeSessionRotationPolicy({ enabled: false, maxPersistedBytes: 12 }), {
    enabled: false,
    maxPersistedBytes: 12
  });
});

test("requests rotation only after a successful oversized compaction", () => {
  assert.equal(compactionRotationRequest(compactionEvent(), 64 * mebibyte), null);
  assert.equal(compactionRotationRequest({ ...compactionEvent(), aborted: true }, 65 * mebibyte), null);
  assert.equal(compactionRotationRequest(compactionEvent(), 65 * mebibyte, { enabled: false }), null);
  const request = compactionRotationRequest(compactionEvent("latest summary"), 65 * mebibyte);
  assert.equal(request.persistedBytes, 65 * mebibyte);
  assert.match(request.handoff, /latest summary/);
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
