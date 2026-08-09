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
        const response = { type: "response", id: request.id, success: true, data: {} };
        if (request.type === "get_state") {
          response.data = { model: { provider: "test", id: "model", reasoning: true }, thinkingLevel: "medium", sessionFile: "/session.jsonl" };
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
            rpcChild.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
            rpcChild.stdout.write(`${JSON.stringify({ type: "message_start", message: { role: "assistant" } })}\n`);
            rpcChild.stdout.write(`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "OK" } })}\n`);
            rpcChild.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } })}\n`);
            rpcChild.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
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
      rpcChild.stdout.write(`${JSON.stringify(record)}\n`);
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

test("handles fragmented JSONL and waits for agent_end", async () => {
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
    spawnImpl: fake.spawnImpl,
    promptSettleDelayMs: 1
  });
  await session.start();

  let completed = false;
  let reply = "";
  const prompting = collectText(session, "hello").then((text) => {
    reply = text;
    completed = true;
  });
  await fake.waitForRequest("prompt");
  fake.write({ type: "agent_start" });
  fake.write({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "WebSocket error" } });
  fake.write({ type: "agent_end" });
  fake.write({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "WebSocket error" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(completed, false);

  fake.write({ type: "agent_start" });
  fake.write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "recovered" } });
  fake.write({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  fake.write({ type: "auto_retry_end", success: true, attempt: 1 });
  fake.write({ type: "agent_end" });
  await prompting;

  assert.equal(completed, true);
  assert.equal(reply, "recovered");
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
    spawnImpl: fake.spawnImpl,
    promptSettleDelayMs: 1
  });
  await session.start();

  let completed = false;
  const prompting = collectText(session, "hello").finally(() => { completed = true; });
  await fake.waitForRequest("prompt");
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
