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
    cache: {
      maxSessions: 3,
      maxPersistedBytes: 48 * 1024 * 1024,
      sessions: 1,
      persistedBytes: 0
    },
    contexts: [{
      chatId: "123",
      activeUsers: 0,
      persistedBytes: 0,
      lastAccessedAt: null,
      messages: 2,
      estimatedTokens: 42,
      tokens: 42,
      contextWindow: 1000,
      percent: 4.2
    }]
  });
});

test("evicts the least recently used inactive session without touching active work", async () => {
  const closed = [];
  const lifecycle = new AgentSessionLifecycle({
    logger: null,
    summarizeContext: () => ({}),
    cachePolicy: { maxSessions: 2, maxPersistedBytes: 1_000 }
  });
  lifecycle.sessions.set("active-old", {
    activeUsers: 1,
    lastAccessedAt: 1,
    persistedBytes: 100,
    session: { async close() { closed.push("active-old"); } }
  });
  lifecycle.sessions.set("inactive-old", {
    activeUsers: 0,
    lastAccessedAt: 2,
    persistedBytes: 100,
    session: { async close() { closed.push("inactive-old"); } }
  });
  lifecycle.sessions.set("current", {
    activeUsers: 1,
    lastAccessedAt: 3,
    persistedBytes: 100,
    session: { async close() { closed.push("current"); } }
  });

  const evicted = await lifecycle.enforceCachePolicy({ protectedSessionKeys: ["current"] });

  assert.deepEqual(evicted, [{ sessionKey: "inactive-old", persistedBytes: 100 }]);
  assert.deepEqual(closed, ["inactive-old"]);
  assert.deepEqual([...lifecycle.sessions.keys()], ["active-old", "current"]);
});

test("uses persisted session weight as a second cache bound", async () => {
  const lifecycle = new AgentSessionLifecycle({
    logger: null,
    summarizeContext: () => ({}),
    cachePolicy: { maxSessions: 10, maxPersistedBytes: 100 }
  });
  lifecycle.sessions.set("large-old", {
    lastAccessedAt: 1,
    persistedBytes: 80,
    session: { close() {} }
  });
  lifecycle.sessions.set("recent", {
    lastAccessedAt: 2,
    persistedBytes: 40,
    session: { close() {} }
  });

  await lifecycle.enforceCachePolicy({ protectedSessionKeys: ["recent"] });

  assert.deepEqual([...lifecycle.sessions.keys()], ["recent"]);
  assert.deepEqual(lifecycle.cacheUsage(), { sessions: 1, persistedBytes: 40 });
});
