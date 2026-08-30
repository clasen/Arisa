import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { BrowserSessionManager } from "../session-manager.js";
import { createPersistentSessionService } from "../daemon-service.js";

function fakeClient({ call = async (operation) => {
  if (operation === "extract") return '{"health":"healthy"}';
  if (operation === "getUrl") return "https://example.com/";
  return "Navigated successfully.";
}, callResult } = {}) {
  return { closed: false, call, callResult, close() { this.closed = true; } };
}

test("session lifecycle is bounded and explicit close releases clients", async () => {
  const clients = [];
  const manager = new BrowserSessionManager({
    createClient: async () => clients[clients.push(fakeClient()) - 1],
    maxSessions: 2,
    ttlMs: 30_000
  });
  const first = await manager.open();
  const second = await manager.open();
  assert.equal(manager.list().length, 2);
  await assert.rejects(manager.open(), /session limit reached/);
  assert.deepEqual(await manager.close(first.id), { id: first.id, closed: true, reason: "explicit" });
  assert.equal(clients[0].closed, true);
  assert.equal(manager.list()[0].id, second.id);
  await manager.closeAll();
  assert.equal(clients[1].closed, true);
});

test("idle sessions expire and active sessions are not reaped", async () => {
  let now = Date.parse("2026-08-28T00:00:00Z");
  const clients = [];
  const manager = new BrowserSessionManager({
    createClient: async () => clients[clients.push(fakeClient()) - 1],
    ttlMs: 5_000,
    now: () => now
  });
  const session = await manager.open();
  now += 5_001;
  const expired = await manager.reapExpired();
  assert.equal(expired[0].reason, "expired");
  assert.equal(clients[0].closed, true);
  assert.throws(() => manager.get(session.id), /Unknown or expired/);
});

test("crashed and cancelled operations close their browser session", async () => {
  const crashed = fakeClient({ call: async () => { throw new Error("browser crashed"); } });
  const crashManager = new BrowserSessionManager({ createClient: async () => crashed });
  const crashSession = await crashManager.open();
  await assert.rejects(crashManager.execute(crashSession.id, "getUrl"), /browser crashed/);
  assert.equal(crashed.closed, true);
  assert.equal(crashManager.list().length, 0);

  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const cancelled = fakeClient({ call: () => pending });
  const cancelManager = new BrowserSessionManager({ createClient: async () => cancelled });
  const cancelSession = await cancelManager.open();
  const controller = new AbortController();
  const execution = cancelManager.execute(cancelSession.id, "getUrl", {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(execution, (error) => error.code === "DAEMON_JOB_CANCELLED");
  assert.equal(cancelled.closed, true);
  assert.equal(cancelManager.list().length, 0);
  release("late result");
});

test("unsafe final navigation closes the persistent session", async () => {
  const client = fakeClient({ call: async (operation) => operation === "getUrl" ? "http://127.0.0.1/private" : "tree" });
  const service = createPersistentSessionService({
    binary: "/unused",
    config: { SESSION_TTL_MS: 30_000, MAX_SESSIONS: 1, SESSION_SWEEP_MS: 10_000 },
    createClient: async () => client,
    lookup: async () => [{ address: "93.184.216.34" }]
  });
  const session = await service.processJob({ action: "session-open" });
  await assert.rejects(
    service.processJob({ action: "session-call", sessionId: session.id, tool: "tree", arguments: {} }),
    /Private or non-public/
  );
  assert.equal(client.closed, true);
  assert.equal(service.manager.list().length, 0);
  await service.close();
});

test("authenticated sessions are identified, unique per resource, and same-site scoped", async () => {
  const clients = [];
  const profiles = [];
  const service = createPersistentSessionService({
    binary: "/unused",
    config: { SESSION_TTL_MS: 30_000, MAX_SESSIONS: 2, SESSION_SWEEP_MS: 10_000 },
    createClient: async (options) => {
      profiles.push(options.authenticatedProfile);
      return clients[clients.push(fakeClient()) - 1];
    },
    profileStore: {
      async open(resourceId) {
        return {
          resourceId,
          publicMetadata: { authenticated: true, resourceId },
          async finish() {}
        };
      }
    },
    lookup: async () => [{ address: "93.184.216.34" }]
  });
  const session = await service.processJob({ action: "session-open-authenticated", resourceId: "example.com" });
  assert.equal(session.authenticated, true);
  assert.equal(session.resourceId, "example.com");
  assert.equal(profiles[0].resourceId, "example.com");
  const reused = await service.processJob({ action: "session-open-authenticated", resourceId: "example.com" });
  assert.equal(reused.id, session.id);
  assert.equal(reused.reused, true);
  await assert.rejects(
    service.processJob({ action: "session-call", sessionId: session.id, tool: "goto", arguments: { url: "https://example.net/" } }),
    /left the shared session scope/
  );
  assert.equal(clients[0].closed, false);
  assert.equal(service.manager.list().length, 1);
  await service.close();
});

test("recoverable MCP misses keep the adaptive session alive", async () => {
  const client = fakeClient({
    call: async (operation) => {
      if (operation === "waitForSelector") throw Object.assign(new Error("NodeNotFound"), { recoverable: true });
      if (operation === "getUrl") return "https://example.com/";
      return "tree";
    }
  });
  const service = createPersistentSessionService({
    binary: "/unused",
    config: { SESSION_TTL_MS: 30_000, MAX_SESSIONS: 1, SESSION_SWEEP_MS: 10_000 },
    createClient: async () => client,
    lookup: async () => [{ address: "93.184.216.34" }]
  });
  const session = await service.processJob({ action: "session-open" });
  await assert.rejects(
    service.processJob({ action: "session-call", sessionId: session.id, tool: "waitForSelector", arguments: { selector: ".missing" } }),
    /NodeNotFound/
  );
  assert.equal(client.closed, false);
  assert.equal(service.manager.list().length, 1);
  const result = await service.processJob({ action: "session-call", sessionId: session.id, tool: "tree", arguments: {} });
  assert.equal(result.text, "tree");
  await service.close();
});

test("session batch keeps one lock, polls in-process, and returns bounded selected outputs", async () => {
  const calls = [];
  let treeCalls = 0;
  const client = fakeClient({
    call: async (operation) => {
      calls.push(operation);
      if (operation === "tree") return ++treeCalls === 1 ? "loading" : "Creators who cover games like Castle Bravo";
      if (operation === "getUrl") return "https://example.com/results";
      return "ok";
    }
  });
  const service = createPersistentSessionService({
    binary: "/unused",
    config: { SESSION_TTL_MS: 30_000, MAX_SESSIONS: 1, SESSION_SWEEP_MS: 10_000, MAX_OUTPUT_BYTES: 8_192 },
    createClient: async () => client,
    lookup: async () => [{ address: "93.184.216.34" }]
  });
  const session = await service.processJob({ action: "session-open" });
  const output = await service.processJob({
    action: "session-batch",
    sessionId: session.id,
    actionLevel: "read",
    steps: [
      { tool: "goto", arguments: { url: "https://example.com/results" }, includeOutput: false },
      { tool: "tree", arguments: {}, repeatUntilIncludes: "creators who cover games like", intervalMs: 100, timeoutMs: 1_000 }
    ]
  });
  assert.equal(output.operations, 2);
  assert.equal(output.steps[0].text, "");
  assert.equal(output.steps[1].attempts, 2);
  assert.match(output.steps[1].text, /Castle Bravo/);
  assert.equal(output.finalUrl, "https://example.com/results");
  assert.deepEqual(calls, ["goto", "tree", "tree", "getUrl"]);
  assert.equal(service.manager.list()[0].busy, false);
  await service.close();
});

test("session batch never repeats interaction or commit operations", async () => {
  const client = fakeClient();
  const service = createPersistentSessionService({
    binary: "/unused",
    config: { SESSION_TTL_MS: 30_000, MAX_SESSIONS: 1, SESSION_SWEEP_MS: 10_000 },
    createClient: async () => client,
    lookup: async () => [{ address: "93.184.216.34" }]
  });
  const session = await service.processJob({ action: "session-open" });
  await assert.rejects(
    service.processJob({
      action: "session-batch",
      sessionId: session.id,
      actionLevel: "commit",
      commitIntent: "submit-form",
      steps: [{ tool: "click", arguments: { selector: "#submit" }, repeatUntilIncludes: "done" }]
    }),
    /allowed only on read operations/
  );
  assert.equal(service.manager.list().length, 1);
  await service.close();
});

test("session capture returns a bounded PNG file result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lp-session-capture-"));
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(800, 16);
  buffer.writeUInt32BE(600, 20);
  const client = fakeClient({ callResult: async () => ({ content: [{ type: "image", mimeType: "image/png", data: buffer.toString("base64") }] }) });
  const service = createPersistentSessionService({
    binary: "/unused",
    config: { SESSION_TTL_MS: 30_000, MAX_SESSIONS: 1, SESSION_SWEEP_MS: 10_000 },
    createClient: async () => client,
    lookup: async () => [{ address: "93.184.216.34" }],
    tmpDir: root
  });
  try {
    const session = await service.processJob({ action: "session-open" });
    const capture = await service.processJob({ action: "session-capture", sessionId: session.id });
    assert.equal(capture.mimeType, "image/png");
    assert.equal(capture.width, 800);
    assert.equal(capture.height, 600);
    assert.equal(capture.delivery.method, "photo");
  } finally {
    await service.close();
    await assert.rejects(access(root));
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon service health exercises MCP and recovery closes all sessions", async () => {
  const clients = [];
  const service = createPersistentSessionService({
    binary: "/unused",
    config: { SESSION_TTL_MS: 30_000, MAX_SESSIONS: 2, SESSION_SWEEP_MS: 10_000 },
    createClient: async () => clients[clients.push(fakeClient()) - 1],
    lookup: async () => [{ address: "93.184.216.34" }]
  });
  const health = await service.healthCheck();
  assert.match(health.message, /navigation, DOM, and extraction are healthy/);
  assert.equal(clients[0].closed, true);
  const session = await service.processJob({ action: "session-open" });
  assert.equal((await service.processJob({ action: "session-list" })).sessions.length, 1);
  assert.equal((await service.processJob({ action: "session-probe", sessionId: session.id })).text, '{"health":"healthy"}');
  const call = await service.processJob({ action: "session-call", sessionId: session.id, tool: "goto", arguments: { url: "https://example.com" } });
  assert.equal(call.finalUrl, "https://example.com/");
  assert.equal(call.tool, "goto");
  await assert.rejects(
    service.processJob({ action: "session-call", sessionId: session.id, tool: "goto", arguments: { url: "http://127.0.0.1" } }),
    /Private or non-public/
  );
  await service.close("recovery");
  assert.equal(clients[1].closed, true);
});
