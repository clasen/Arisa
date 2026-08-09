import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { PrimeRpcSession, validatePrimeBinary } from "../src/core/agent/prime-rpc-session.js";
import { defaultPrimeVersion } from "../src/core/config/config-defaults.js";
import { collectText } from "../src/transport/telegram/bot.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    child.emit("close", null, signal);
  };
  return child;
}

function versionSpawner(version = defaultPrimeVersion) {
  return (_command, args) => {
    assert.deepEqual(args, ["--version"]);
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.end(`prime-agent v${version}\n`);
      child.exitCode = 0;
      child.emit("close", 0, null);
    });
    return child;
  };
}

function rpcSpawner({ onUnsolicitedText, autoCompletePrompt = true } = {}) {
  let call = 0;
  let rpcChild;
  let rpcOptions;
  const requests = [];
  const rpcState = {
    model: { provider: "test", id: "model", reasoning: true },
    thinkingLevel: "medium",
    sessionFile: "/session.jsonl",
    isStreaming: false,
    isCompacting: false,
    sessionActions: { queuedCount: 0, steering: [], followUps: [] }
  };
  const writeRecord = (record) => {
    if (record.type === "agent_start") rpcState.isStreaming = true;
    if (record.type === "agent_end") rpcState.isStreaming = false;
    if (record.type === "compaction_start") rpcState.isCompacting = true;
    if (record.type === "compaction_end") rpcState.isCompacting = false;
    if (record.type === "session_action_update") rpcState.sessionActions = record.actions;
    rpcChild.stdout.write(`${JSON.stringify(record)}\n`);
  };
  const spawnImpl = (_command, args, options) => {
    call += 1;
    if (call % 2 === 1) return versionSpawner()(_command, ["--version"]);
    assert.ok(args.includes("rpc"));
    assert.ok(args.includes("--offline"));
    rpcOptions = options;
    rpcChild = fakeChild();
    rpcChild.stdin.once("finish", () => {
      rpcChild.exitCode = 0;
      rpcChild.emit("close", 0, null);
    });
    let input = "";
    rpcChild.stdin.on("data", (chunk) => {
      input += chunk.toString("utf8");
      let newline = input.indexOf("\n");
      while (newline !== -1) {
        const request = JSON.parse(input.slice(0, newline));
        input = input.slice(newline + 1);
        requests.push(request);
        if (request.type === "extension_ui_response") {
          newline = input.indexOf("\n");
          continue;
        }
        if (request.type === "prompt") {
          rpcState.sessionActions = { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "running" } };
        }
        const response = { type: "response", id: request.id, success: true, data: {} };
        if (request.type === "get_state") {
          response.data = { ...rpcState, sessionActions: { ...rpcState.sessionActions } };
        } else if (request.type === "get_messages") {
          response.data = { messages: [] };
        } else if (request.type === "get_available_models") {
          response.data = { models: [{ provider: "test", id: "model", reasoning: true }] };
        } else if (request.type === "set_model") {
          response.data = { provider: request.provider, id: request.modelId, reasoning: true };
        }
        const line = `${JSON.stringify(response)}\n`;
        rpcChild.stdout.write(line.slice(0, 7));
        rpcChild.stdout.write(line.slice(7));
        if (request.type === "prompt" && autoCompletePrompt) {
          queueMicrotask(() => {
            writeRecord({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "running" } } });
            writeRecord({ type: "agent_start" });
            writeRecord({ type: "message_start", message: { role: "assistant" } });
            writeRecord({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "OK" } });
            writeRecord({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
            writeRecord({ type: "agent_end" });
            writeRecord({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } });
          });
        }
        newline = input.indexOf("\n");
      }
    });
    return rpcChild;
  };
  return {
    spawnImpl,
    requests,
    write(record) {
      writeRecord(record);
    },
    async waitForRequest(type) {
      while (!requests.some((request) => request.type === type)) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    get child() { return rpcChild; },
    get options() { return rpcOptions; },
    onUnsolicitedText
  };
}

test("requires the pinned Prime Agent version", async () => {
  await assert.rejects(
    validatePrimeBinary({ spawnImpl: versionSpawner("0.8.0") }),
    /requires exactly 0\.7\.1/
  );
});

test("validates a managed Prime CLI through the current Node executable", async () => {
  const cliPath = "/managed/prime-agent/dist/bundle/cli.js";
  const result = await validatePrimeBinary({
    command: process.execPath,
    commandArgs: [cliPath],
    expectedVersion: defaultPrimeVersion,
    spawnImpl: (_command, args) => {
      assert.deepEqual(args, [cliPath, "--version"]);
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.end(`prime-agent v${defaultPrimeVersion}\n`);
        child.exitCode = 0;
        child.emit("close", 0, null);
      });
      return child;
    }
  });

  assert.equal(result.version, defaultPrimeVersion);
});

test("handles fragmented JSONL and waits for the Prime session action to settle", async () => {
  const fake = rpcSpawner();
  const session = new PrimeRpcSession({
    command: "prime-agent",
    expectedVersion: defaultPrimeVersion,
    provider: "test",
    model: "model",
    cwd: process.cwd(),
    agentDir: process.cwd(),
    sessionDir: process.cwd(),
    kernelVenvDir: "/managed/prime-kernel",
    chatId: "42",
    noSession: true,
    spawnImpl: fake.spawnImpl
  });
  let text = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") text += event.assistantMessageEvent.delta;
  });
  await session.prompt("hello");
  assert.equal(fake.options.env.PRIME_AGENT_KERNEL_VENV, "/managed/prime-kernel");
  assert.equal(text, "OK");
  assert.equal(session.sessionFile, "/session.jsonl");
  assert.ok(fake.requests.some((request) => request.type === "prompt" && request.streamingBehavior === "followUp"));
  assert.deepEqual(await session.getAvailableModels(), [{ provider: "test", id: "model", reasoning: true }]);
  await session.setThinkingLevel("high");
  await session.setModel("test", "next-model");
  assert.ok(fake.requests.some((request) => request.type === "set_thinking_level" && request.level === "high"));
  assert.ok(fake.requests.some((request) => request.type === "set_model" && request.modelId === "next-model"));
  unsubscribe();
  await session.close();
});

test("keeps a prompt pending while Prime automatically retries", async () => {
  const fake = rpcSpawner({ autoCompletePrompt: false });
  const session = new PrimeRpcSession({
    provider: "test",
    model: "model",
    cwd: process.cwd(),
    agentDir: process.cwd(),
    sessionDir: process.cwd(),
    chatId: "42",
    noSession: true,
    spawnImpl: fake.spawnImpl
  });
  await session.start();

  let completed = false;
  let reply = "";
  let settledEvents = 0;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_settled") settledEvents += 1;
  });
  const prompting = collectText(session, "hello").then((text) => {
    reply = text;
    completed = true;
  });
  await fake.waitForRequest("prompt");
  fake.write({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "running" } } });
  fake.write({ type: "agent_start" });
  fake.write({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "WebSocket error" } });
  fake.write({ type: "agent_end" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  fake.write({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "WebSocket error" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(completed, false);
  assert.equal(settledEvents, 0);

  fake.write({ type: "agent_start" });
  fake.write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "recovered" } });
  fake.write({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  fake.write({ type: "auto_retry_end", success: true, attempt: 1 });
  fake.write({ type: "agent_end" });
  assert.equal(completed, false);
  assert.equal(settledEvents, 0);
  fake.write({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } });
  await prompting;

  assert.equal(completed, true);
  assert.equal(reply, "recovered");
  assert.equal(settledEvents, 1);
  unsubscribe();
  await session.close();
});

test("does not dispatch a prompt while Prime still owns a session action", async () => {
  const fake = rpcSpawner();
  const session = new PrimeRpcSession({
    provider: "test",
    model: "model",
    cwd: process.cwd(),
    agentDir: process.cwd(),
    sessionDir: process.cwd(),
    chatId: "42",
    noSession: true,
    spawnImpl: fake.spawnImpl
  });
  await session.start();
  fake.write({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "running" } } });

  const prompting = session.prompt("wait for the existing turn");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.requests.some((request) => request.type === "prompt"), false);

  fake.write({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } });
  await prompting;
  assert.equal(fake.requests.filter((request) => request.type === "prompt").length, 1);
  await session.close();
});

test("does not mix an existing Prime action into the next collected reply", async () => {
  const delivered = [];
  const fake = rpcSpawner({ autoCompletePrompt: false });
  const session = new PrimeRpcSession({
    provider: "test",
    model: "model",
    cwd: process.cwd(),
    agentDir: process.cwd(),
    sessionDir: process.cwd(),
    chatId: "42",
    noSession: true,
    spawnImpl: fake.spawnImpl,
    onUnsolicitedText: (text) => delivered.push(text)
  });
  await session.start();
  fake.write({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "running" } } });
  fake.write({ type: "agent_start" });

  const prompting = collectText(session, "new request");
  fake.write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "old" } });
  fake.write({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  fake.write({ type: "agent_end" });
  fake.write({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } });
  await fake.waitForRequest("prompt");

  fake.write({ type: "agent_start" });
  fake.write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "new" } });
  fake.write({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  fake.write({ type: "agent_end" });
  fake.write({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } });

  assert.equal(await prompting, "new");
  assert.deepEqual(delivered, ["old"]);
  await session.close();
});

test("keeps a prompt pending through Prime compaction and continuation", async () => {
  const fake = rpcSpawner({ autoCompletePrompt: false });
  const session = new PrimeRpcSession({
    provider: "test",
    model: "model",
    cwd: process.cwd(),
    agentDir: process.cwd(),
    sessionDir: process.cwd(),
    chatId: "42",
    noSession: true,
    spawnImpl: fake.spawnImpl
  });
  await session.start();

  let completed = false;
  const prompting = collectText(session, "hello").then((text) => {
    completed = true;
    return text;
  });
  await fake.waitForRequest("prompt");
  fake.write({ type: "agent_start" });
  fake.write({ type: "agent_end" });
  fake.write({ type: "compaction_start", reason: "auto" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);

  fake.write({ type: "compaction_end", reason: "auto", aborted: false });
  fake.write({ type: "agent_start" });
  fake.write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "continued" } });
  fake.write({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  fake.write({ type: "agent_end" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);

  fake.write({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } });
  assert.equal(await prompting, "continued");
  assert.equal(completed, true);
  await session.close();
});

test("completes a prompt after Prime exhausts automatic retries", async () => {
  const fake = rpcSpawner({ autoCompletePrompt: false });
  const session = new PrimeRpcSession({
    provider: "test",
    model: "model",
    cwd: process.cwd(),
    agentDir: process.cwd(),
    sessionDir: process.cwd(),
    chatId: "42",
    noSession: true,
    spawnImpl: fake.spawnImpl
  });
  await session.start();

  let completed = false;
  const prompting = collectText(session, "hello").finally(() => { completed = true; });
  await fake.waitForRequest("prompt");
  fake.write({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "running" } } });
  fake.write({ type: "agent_start" });
  fake.write({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "WebSocket error" } });
  fake.write({ type: "agent_end" });
  fake.write({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 1, errorMessage: "WebSocket error" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(completed, false);

  fake.write({ type: "agent_start" });
  fake.write({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "WebSocket error" } });
  fake.write({ type: "agent_end" });
  fake.write({ type: "auto_retry_end", success: false, attempt: 1, finalError: "WebSocket error" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  fake.write({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } });
  await assert.rejects(prompting, /WebSocket error/);

  assert.equal(completed, true);
  await session.close();
});

test("returns extension UI dialog responses over RPC", async () => {
  const fake = rpcSpawner();
  const session = new PrimeRpcSession({
    provider: "test",
    model: "model",
    cwd: process.cwd(),
    agentDir: process.cwd(),
    sessionDir: process.cwd(),
    chatId: "42",
    noSession: true,
    spawnImpl: fake.spawnImpl,
    onUiRequest: async (request) => ({ value: request.options[0] })
  });
  await session.start();
  fake.child.stdout.write(`${JSON.stringify({
    type: "extension_ui_request",
    id: "ui-1",
    method: "select",
    message: "Choose",
    options: ["Allow", "Deny"]
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fake.requests.some((request) => request.type === "extension_ui_response" && request.id === "ui-1" && request.value === "Allow"));
  await session.close();
});

test("delivers a later spontaneous agent turn once", async () => {
  const delivered = [];
  const fake = rpcSpawner();
  const session = new PrimeRpcSession({
    provider: "test",
    model: "model",
    cwd: process.cwd(),
    agentDir: process.cwd(),
    sessionDir: process.cwd(),
    chatId: "42",
    noSession: true,
    spawnImpl: fake.spawnImpl,
    onUnsolicitedText: (text) => delivered.push(text)
  });
  await session.prompt("hello");
  fake.child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  fake.child.stdout.write(`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "worker result" } })}\n`);
  fake.child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ["worker result"]);
  await session.close();
});

test("waits for a stuck Prime RPC to exit before allowing session reuse", async () => {
  const child = fakeChild();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("close", null, signal));
    }
    return true;
  };

  const session = new PrimeRpcSession({
    closeTimeoutMs: 5,
    terminateTimeoutMs: 5
  });
  session.child = child;

  await session.close();

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.signalCode, "SIGKILL");
});
