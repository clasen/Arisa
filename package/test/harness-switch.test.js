import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatPortableSessionHistory } from "../src/core/agent/agent-manager.js";
import { agentConfigDefaults, applyConfigDefaults, doctorConfigDefaults } from "../src/core/config/config-defaults.js";
import { ConversationHistoryStore, formatPortableConversation } from "../src/core/conversation/conversation-history-store.js";
import { buildConfig } from "../src/runtime/bootstrap.js";
import { activateHarness } from "../src/runtime/harness-switch.js";
import { listHarnessTransitionPrimeOwners, recordHarnessTransition } from "../src/runtime/harness-transition-journal.js";
import { createChatStateStore } from "../src/transport/telegram/bot.js";
import { buildHarnessPicker, parseHarnessPickerAction } from "../src/transport/telegram/harness-picker.js";

test("uses Pi as the authoritative default for new installations", () => {
  assert.equal(agentConfigDefaults.runtime, "pi");
  assert.equal(applyConfigDefaults({ telegram: {}, pi: {} }).agent.runtime, "pi");
  assert.deepEqual(applyConfigDefaults({ telegram: {}, pi: {} }).doctor, doctorConfigDefaults);
  assert.equal(buildConfig({
    telegramApiKey: "telegram-token",
    telegramMaxChatIds: 1,
    provider: "openai-codex",
    model: "gpt-test",
    piApiKey: ""
  }).agent.runtime, "pi");
});

test("prepares, validates, persists, and activates a harness in order", async () => {
  const config = {
    agent: { runtime: "pi" },
    pi: { provider: "test", model: "pi-model" },
    prime: { command: "", version: "0.7.0", provider: "test", model: "prime-model" }
  };
  const calls = [];
  const traces = [];
  const handoffs = new Map([["42", "portable history"]]);

  const result = await activateHarness({
    config,
    targetRuntime: "prime",
    prepareRuntime: async (candidate) => {
      calls.push("prepare");
      assert.equal(candidate.agent.runtime, "prime");
      return {
        ...candidate,
        prime: { ...candidate.prime, command: process.execPath, commandArgs: ["/managed/prime.js"] }
      };
    },
    validateRuntime: async (candidate) => {
      calls.push("validate");
      assert.deepEqual(candidate.prime.commandArgs, ["/managed/prime.js"]);
    },
    prepareContinuity: async () => {
      calls.push("continuity");
      return handoffs;
    },
    saveConfig: async (candidate) => {
      calls.push("save");
      assert.equal(config.agent.runtime, "pi");
      assert.equal(candidate.agent.runtime, "prime");
    },
    switchRuntime: async (candidate, options) => {
      calls.push("switch");
      assert.equal(candidate.agent.runtime, "prime");
      assert.equal(options.handoffs, handoffs);
      assert.equal(config.agent.runtime, "pi");
      assert.equal(options.onActivate(candidate), config);
      assert.equal(config.agent.runtime, "prime");
    },
    traceTransition: async (event) => {
      calls.push(`trace:${event.phase}`);
      traces.push(event);
    }
  });

  assert.deepEqual(calls, ["trace:started", "prepare", "validate", "continuity", "save", "switch", "trace:completed"]);
  assert.equal(result.changed, true);
  assert.equal(result.runtime, "prime");
  assert.equal(result.transitionId, traces[0].transitionId);
  assert.equal(traces[1].transitionId, traces[0].transitionId);
  assert.deepEqual(traces.map(({ phase, fromRuntime, toRuntime }) => ({ phase, fromRuntime, toRuntime })), [{
    phase: "started",
    fromRuntime: "pi",
    toRuntime: "prime"
  }, {
    phase: "completed",
    fromRuntime: "pi",
    toRuntime: "prime"
  }]);
  assert.equal(config.agent.runtime, "prime");
  assert.deepEqual(config.prime.commandArgs, ["/managed/prime.js"]);
});

test("keeps the active harness unchanged when preparation fails", async () => {
  const config = { agent: { runtime: "pi" }, pi: {}, prime: {} };
  let persisted = false;
  let switched = false;
  const phases = [];

  await assert.rejects(activateHarness({
    config,
    targetRuntime: "prime",
    prepareRuntime: async () => { throw new Error("install failed"); },
    validateRuntime: async () => {},
    prepareContinuity: async () => new Map(),
    saveConfig: async () => { persisted = true; },
    switchRuntime: async () => { switched = true; },
    traceTransition: async ({ phase }) => { phases.push(phase); }
  }), /install failed/);

  assert.equal(config.agent.runtime, "pi");
  assert.equal(persisted, false);
  assert.equal(switched, false);
  assert.deepEqual(phases, ["started", "failed"]);
});

test("restores the persisted harness if live activation fails", async () => {
  const config = { agent: { runtime: "pi" }, pi: {}, prime: {} };
  const persistedRuntimes = [];
  const phases = [];

  await assert.rejects(activateHarness({
    config,
    targetRuntime: "prime",
    prepareRuntime: async (candidate) => candidate,
    validateRuntime: async () => {},
    prepareContinuity: async () => new Map(),
    saveConfig: async (candidate) => { persistedRuntimes.push(candidate.agent.runtime); },
    switchRuntime: async () => { throw new Error("activation failed"); },
    traceTransition: async ({ phase }) => { phases.push(phase); }
  }), /activation failed/);

  assert.deepEqual(persistedRuntimes, ["prime", "pi"]);
  assert.deepEqual(phases, ["started", "rolled_back"]);
  assert.equal(config.agent.runtime, "pi");
});

test("rolls back the harness if the completed transition cannot be traced", async () => {
  const config = { agent: { runtime: "pi" }, pi: {}, prime: {} };
  const persistedRuntimes = [];
  const phases = [];

  await assert.rejects(activateHarness({
    config,
    targetRuntime: "prime",
    prepareRuntime: async (candidate) => candidate,
    validateRuntime: async () => {},
    prepareContinuity: async () => new Map(),
    saveConfig: async (candidate) => { persistedRuntimes.push(candidate.agent.runtime); },
    switchRuntime: async (candidate, { onActivate }) => { onActivate(candidate); },
    traceTransition: async ({ phase }) => {
      phases.push(phase);
      if (phase === "completed") throw new Error("trace unavailable");
    }
  }), /trace unavailable/);

  assert.deepEqual(persistedRuntimes, ["prime", "pi"]);
  assert.deepEqual(phases, ["started", "completed", "rolled_back"]);
  assert.equal(config.agent.runtime, "pi");
});

test("persists Prime ownership in the harness transition journal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-harness-transition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "harness-transitions.jsonl");
  const transitionId = "prime-to-pi-1";
  const owner = {
    registryDir: "/tmp/arisa-prime/supervisor-owners",
    pid: 555,
    processStartId: "ps:expected-start",
    socketPath: "/tmp/arisa-prime/daemon.sock",
    descriptorDir: "/tmp/arisa-prime/daemon-workers/worker",
    agentDir: "/tmp/arisa-prime",
    appVersion: "0.7.1"
  };
  await recordHarnessTransition({
    transitionId,
    phase: "started",
    fromRuntime: "prime",
    toRuntime: "pi",
    primeDaemons: [owner]
  }, { file, recordedAt: "2026-08-09T12:00:00.000Z" });
  await recordHarnessTransition({
    transitionId,
    phase: "completed",
    fromRuntime: "prime",
    toRuntime: "pi"
  }, { file, recordedAt: "2026-08-09T12:00:01.000Z" });
  const failedTransitionId = "pi-to-prime-failed-1";
  const failedOwner = {
    ...owner,
    pid: 556,
    processStartId: "ps:failed-start"
  };
  await recordHarnessTransition({
    transitionId: failedTransitionId,
    phase: "failed",
    fromRuntime: "pi",
    toRuntime: "prime",
    primeDaemons: [failedOwner]
  }, { file, recordedAt: "2026-08-09T12:00:02.000Z" });

  assert.equal((await readFile(file, "utf8")).startsWith("\uFEFF"), true);
  assert.deepEqual(await listHarnessTransitionPrimeOwners({ file }), [
    { ...owner, transitionId },
    { ...failedOwner, transitionId: failedTransitionId }
  ]);
});

test("builds and parses the Telegram harness picker", () => {
  const picker = buildHarnessPicker("pi");
  assert.match(picker.text, /Pi Agent/);
  assert.equal(picker.replyMarkup.inline_keyboard[0][0].text, "✓ Pi Agent");
  assert.equal(picker.replyMarkup.inline_keyboard[1][0].callback_data, "harness:prime");
  assert.deepEqual(parseHarnessPickerAction("harness:prime"), { runtime: "prime" });
  assert.equal(parseHarnessPickerAction("harness:other"), null);
});

test("detects active work across every Telegram chat before a global switch", () => {
  const states = createChatStateStore();
  assert.equal(states.anyProcessing(), false);
  states.get(42).processing = true;
  assert.equal(states.anyProcessing(), true);
  states.reset(42);
  assert.equal(states.anyProcessing(), false);
});

test("persists a complete portable conversation with a UTF-8 BOM", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "conversation.jsonl");
  const history = new ConversationHistoryStore({ historyFile: () => file });

  assert.equal(await history.ensureSeed("42", {
    runtime: "pi",
    history: "User:\nEarlier question\n\nAssistant:\nEarlier answer"
  }), true);
  assert.equal(await history.ensureSeed("42", { runtime: "pi", history: "duplicate" }), false);
  await history.appendTurn("42", {
    runtime: "pi",
    prompt: "Latest question",
    response: "Latest answer"
  });

  const contents = await readFile(file, "utf8");
  assert.equal(contents.startsWith("\uFEFF"), true);
  const records = await history.read("42");
  assert.equal(records.length, 2);
  assert.match(formatPortableConversation(records), /Earlier question/);
  assert.match(await history.buildHandoff("42"), /Latest answer/);

  await history.reset("42", { runtime: "prime", history: "Durable summary" });
  const resetRecords = await history.read("42");
  assert.equal(resetRecords.length, 1);
  assert.equal(resetRecords[0].history, "Durable summary");
});

test("exports readable user, assistant, and compacted session context", () => {
  assert.equal(formatPortableSessionHistory([
    { role: "user", content: [{ type: "text", text: "Question" }] },
    { role: "assistant", content: "Answer" },
    { customType: "compaction", content: "Durable memory" },
    { role: "assistant", content: [{ type: "toolCall", name: "ignored" }] }
  ]), [
    "User:\nQuestion",
    "Assistant:\nAnswer",
    "Session memory (compaction):\nDurable memory"
  ].join("\n\n"));
});
