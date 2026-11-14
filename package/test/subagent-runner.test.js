import assert from "node:assert/strict";
import test from "node:test";
import { applyConfigDefaults } from "../src/core/config/config-defaults.js";
import { AgentManager } from "../src/core/agent/agent-manager.js";
import { SubagentRunner, promptForFinalText } from "../src/core/agent/subagent-runner.js";

// Scripted stand-in for a Pi session: each step is one assistant message.
function fakeSession(steps) {
  const listeners = new Set();
  const session = {
    aborted: false,
    closed: false,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      for (const step of steps) {
        if (session.aborted) return;
        await new Promise((resolve) => setImmediate(resolve));
        for (const listener of listeners) {
          listener({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: step.stopReason,
              errorMessage: step.errorMessage,
              content: step.text ? [{ type: "text", text: step.text }] : [],
              usage: { input: 100, cacheRead: 900, output: 10 }
            }
          });
        }
      }
    },
    async abort() { session.aborted = true; },
    async close() { session.closed = true; }
  };
  return session;
}

const toolUse = { stopReason: "toolUse" };

function createRunner(limits = {}) {
  return new SubagentRunner({ config: { maxModelCalls: 80, timeoutMs: 60_000, ...limits } });
}

function run(runner, session, overrides = {}) {
  return runner.run({
    parentKey: "chat-1",
    kind: "delegate",
    label: "test task",
    openSession: async () => session,
    execute: (opened) => promptForFinalText(opened, "brief"),
    ...overrides
  });
}

test("returns only the final report and records usage for a completed run", async () => {
  const runner = createRunner();
  const session = fakeSession([
    { ...toolUse, text: "looking around" },
    toolUse,
    { stopReason: "stop", text: "done: wrote tools/x/index.js" }
  ]);

  const result = await run(runner, session);

  assert.equal(result.status, "completed");
  assert.equal(result.report, "done: wrote tools/x/index.js");
  assert.equal(result.modelCalls, 3);
  assert.equal(session.closed, true);
  const [record] = runner.diagnostic().recent;
  assert.deepEqual(record.tokens, { input: 300, cacheRead: 2700, output: 30 });
  assert.deepEqual(runner.diagnostic().active, []);
});

test("stops a run that exhausts its model-call budget", async () => {
  const runner = createRunner({ maxModelCalls: 2 });
  const session = fakeSession([toolUse, toolUse, toolUse, { stopReason: "stop", text: "never reached" }]);

  const result = await run(runner, session);

  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, "max_model_calls");
  assert.equal(result.modelCalls, 2);
  assert.equal(session.aborted, true);
});

test("allows one run per parent chat and frees the slot afterwards", async () => {
  const runner = createRunner();
  const first = run(runner, fakeSession([toolUse, { stopReason: "stop", text: "first" }]));

  await assert.rejects(run(runner, fakeSession([])), /already running for chat chat-1/);
  const other = await run(runner, fakeSession([{ stopReason: "stop", text: "other chat" }]), { parentKey: "chat-2" });
  assert.equal(other.report, "other chat");

  assert.equal((await first).report, "first");
  const again = await run(runner, fakeSession([{ stopReason: "stop", text: "second" }]));
  assert.equal(again.report, "second");
});

test("aborts the active run of a chat on request", async () => {
  const runner = createRunner();
  const session = fakeSession([toolUse, toolUse, toolUse, toolUse]);
  const pending = run(runner, session);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await runner.abort("chat-1", "timeout"), true);
  const result = await pending;

  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, "timeout");
  assert.equal(await runner.abort("chat-1"), false);
});

test("propagates provider errors from the subagent and records the failure", async () => {
  const runner = createRunner();
  const session = fakeSession([{ stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" }]);

  await assert.rejects(run(runner, session), /usage limit/);
  assert.equal(runner.diagnostic().recent[0].status, "failed");
  assert.equal(session.closed, true);
});

test("rejects invalid subagent limits", () => {
  assert.throws(() => createRunner({ maxModelCalls: 0 }), /pi\.subagents\.maxModelCalls/);
  assert.throws(() => createRunner({ timeoutMs: undefined }), /pi\.subagents\.timeoutMs/);
});

test("aborting a chat session also stops its subagent", async () => {
  const config = applyConfigDefaults({ telegram: {}, pi: { provider: "test", model: "test" } });
  const manager = new AgentManager({ config, artifactStore: {}, toolRegistry: {}, taskStore: {} });
  const session = fakeSession([toolUse, toolUse, toolUse, toolUse]);
  const pending = run(manager.subagents, session);
  await new Promise((resolve) => setImmediate(resolve));

  await manager.abortSession("chat-1");

  assert.equal((await pending).status, "stopped");
  assert.equal(manager.subagents.diagnostic().limits.maxModelCalls, config.pi.subagents.maxModelCalls);
});
