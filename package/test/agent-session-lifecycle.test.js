import assert from "node:assert/strict";
import test from "node:test";
import { AgentSessionLifecycle } from "../src/core/agent/agent-session-lifecycle.js";

test("session lifecycle owns cache closure and pending handoffs", async () => {
  let closes = 0;
  const lifecycle = new AgentSessionLifecycle({
    logger: null,
    summarizeContext: () => ({ messages: 0, estimatedTokens: 0 })
  });
  lifecycle.sessions.set("chat", {
    session: {
      async close() { closes += 1; }
    }
  });

  lifecycle.resetSession("chat", { handoff: "continue here", parentSession: "parent.jsonl" });
  await lifecycle.waitForClose("chat");

  assert.equal(closes, 1);
  assert.equal(lifecycle.sessions.has("chat"), false);
  assert.equal(lifecycle.pendingNewSessions.has("chat"), true);
  assert.deepEqual(lifecycle.pendingSessionHandoffs.get("chat"), {
    text: "continue here",
    parentSession: "parent.jsonl"
  });

  lifecycle.completeNewSession("chat");
  assert.equal(lifecycle.pendingNewSessions.has("chat"), false);
  assert.equal(lifecycle.pendingSessionHandoffs.has("chat"), false);
});

test("session lifecycle diagnostics remain available after extraction", async () => {
  const lifecycle = new AgentSessionLifecycle({
    logger: null,
    summarizeContext: () => ({ messages: 2, estimatedTokens: 42 })
  });
  lifecycle.sessions.set("123", {
    session: {
      messages: [{ role: "user" }, { role: "assistant" }],
      getSessionStats: () => ({ contextUsage: { tokens: 42, contextWindow: 1000, percent: 4.2 } })
    }
  });

  assert.deepEqual(await lifecycle.getDiagnostic(), {
    harness: "pi",
    sessions: 1,
    closingSessions: 0,
    contexts: [{
      chatId: "123",
      messages: 2,
      estimatedTokens: 42,
      tokens: 42,
      contextWindow: 1000,
      percent: 4.2
    }]
  });
});
