import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelUsageStore, trackModelUsage } from "../src/core/agent/model-usage.js";
import { formatModelUsageReport } from "../src/runtime/model-usage-report.js";
import { reportWidth } from "../src/runtime/report-format.js";
import { describePromptTrigger } from "../src/transport/telegram/prompt-builders.js";
import { createTelegramUsageCommandHandler } from "../src/transport/telegram/telegram-usage-command.js";

const hourMs = 3_600_000;

function fakeSession() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    user(text) {
      this.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
    },
    assistant(usage, model = "gpt-6-astra") {
      this.emit({ type: "message_end", message: { role: "assistant", model, usage } });
    }
  };
}

function memoryStore() {
  const runs = [];
  return { runs, record: async (chatId, run) => runs.push({ chatId, ...run }) };
}

async function withStore(options, work) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "arisa-model-usage-"));
  try {
    await work(new ModelUsageStore({ resolveFile: (chatId) => path.join(dir, `${chatId}.json`), ...options }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(overrides = {}) {
  return {
    at: "2026-11-14T15:05:00.000Z",
    kind: "message",
    detail: "crear flightmode-deploy-watch",
    model: "gpt-6-astra",
    speed: 2,
    modelCalls: 24,
    input: 200_000,
    cacheRead: 990_000,
    output: 10_000,
    ...overrides
  };
}

test("records one run per agent run with its trigger, model, speed and summed usage", () => {
  const session = fakeSession();
  const store = memoryStore();
  let speed = 2;
  trackModelUsage(session, {
    store,
    chatId: 7,
    getSpeed: () => speed,
    describePrompt: describePromptTrigger,
    now: () => Date.parse("2026-11-14T15:05:00.000Z")
  });

  session.user("Incoming Telegram message.\nchatId: 7\ntext: deploy the site\nUse read/write/edit.");
  session.assistant({ input: 100, cacheRead: 900, output: 10 });
  session.user("Incoming Telegram message.\ntext: steered while running");
  session.assistant({ input: 50, cacheRead: 1_000, output: 5 });
  session.emit({ type: "agent_end" });
  speed = 1;
  session.user("Scheduled task fired.\ntaskId: 12\ntext: check SEO");
  session.assistant({ input: 10, cacheRead: 0, output: 1 }, "gpt-5.6-sol");
  session.emit({ type: "agent_end" });
  session.emit({ type: "agent_end" });

  assert.deepEqual(store.runs, [
    { chatId: 7, at: "2026-11-14T15:05:00.000Z", kind: "message", detail: "deploy the site", model: "gpt-6-astra", speed: 2, modelCalls: 2, input: 150, cacheRead: 1_900, output: 15 },
    { chatId: 7, at: "2026-11-14T15:05:00.000Z", kind: "task", detail: "check SEO", model: "gpt-5.6-sol", speed: 1, modelCalls: 1, input: 10, cacheRead: 0, output: 1 }
  ]);
});

test("a fixed trigger names delegated runs and a retried run keeps its trigger", () => {
  const session = fakeSession();
  const store = memoryStore();
  trackModelUsage(session, {
    store,
    chatId: 7,
    getSpeed: () => 1,
    describePrompt: describePromptTrigger,
    trigger: { kind: "delegate", detail: "fix tests" }
  });

  session.user("Delegated task from the main Arisa agent.\nBrief:\nfix tests");
  session.assistant({ input: 5, cacheRead: 0, output: 1 });
  session.emit({ type: "agent_end" });
  session.assistant({ input: 7, cacheRead: 0, output: 1 });
  session.emit({ type: "agent_end" });

  assert.deepEqual(store.runs.map((entry) => [entry.kind, entry.detail, entry.input]), [
    ["delegate", "fix tests", 5],
    ["delegate", "fix tests", 7]
  ]);
});

test("describes the trigger of each prompt format", () => {
  assert.deepEqual(describePromptTrigger("Incoming Telegram message.\nmessageId: 1\nkind: voice\ntranscriptText: hola"), { kind: "message", detail: "hola" });
  assert.deepEqual(describePromptTrigger("External event arrived.\ntaskId: 9\nevent: new WhatsApp message"), { kind: "event", detail: "new WhatsApp message" });
  assert.deepEqual(describePromptTrigger("System event: /new requested.\nSession was reset."), { kind: "new", detail: "" });
  assert.deepEqual(describePromptTrigger("Prepare a concise handoff for the next Arisa session.\nmore"), { kind: "other", detail: "Prepare a concise handoff for the next Arisa session." });
});

test("the store keeps runs per chat and drops those older than the window", async () => {
  let now = Date.parse("2026-11-14T16:00:00.000Z");
  await withStore({ config: { windowMs: 24 * hourMs }, now: () => now }, async (store) => {
    await Promise.all([
      store.record(7, run({ at: "2026-11-13T15:00:00.000Z", detail: "old" })),
      store.record(7, run({ at: "2026-11-14T15:05:00.000Z", detail: "recent" })),
      store.record(8, run({ detail: "other chat" }))
    ]);
    assert.deepEqual((await store.list(7)).map((entry) => entry.detail), ["recent"]);

    now += 24 * hourMs;
    await store.record(7, run({ at: new Date(now).toISOString(), detail: "next day" }));
    assert.deepEqual((await store.list(7)).map((entry) => entry.detail), ["next day"]);
    assert.deepEqual(await store.list(9), []);
  });
  assert.throws(() => new ModelUsageStore({ config: { windowMs: 0 } }), /pi\.usage\.windowMs/);
});

test("the report totals per model and lists the costliest runs within the report width", () => {
  const report = formatModelUsageReport({
    runs: [
      run({ at: "2026-11-14T11:57:00.000Z", kind: "task", detail: "SEO de arisa-site", speed: 1, modelCalls: 10, input: 50_000, cacheRead: 540_000, output: 10_000 }),
      run(),
      run({ at: "2026-11-14T13:48:00.000Z", detail: "x".repeat(80), model: "gpt-5.6-sol", modelCalls: 1, input: 300, cacheRead: 0, output: 20 })
    ],
    windowMs: 24 * hourMs,
    maxRows: 2
  });
  const lines = report.split("\n").slice(1, -1);

  assert.ok(lines.every((line) => [...line].length <= reportWidth));
  assert.equal(lines[0], "Token usage (last 24h)");
  assert.match(lines[2], /^Total · 35 calls +1\.8M$/);
  assert.match(lines[3], /^ {2}gpt-6-astra +1\.8M$/);
  assert.match(lines[4], /^ {2}gpt-5\.6-sol +320$/);
  assert.equal(lines[6], "Top runs (2 of 3)");
  assert.match(lines[7], /^\d\d:\d\d msg crear flightmode-d… +1\.2M$/);
  assert.equal(lines[8], "  gpt-6-astra x2 · 24 calls");
  assert.match(lines[9], /^\d\d:\d\d task SEO de arisa-site +600k$/);
  assert.equal(lines[10], "  gpt-6-astra x1 · 10 calls");
  assert.match(lines[11], /^1 more +320$/);
});

test("the report says when nothing ran in the window", () => {
  assert.match(formatModelUsageReport({ runs: [], windowMs: 24 * hourMs, maxRows: 12 }), /\(none\)/);
});

test("/usage replies with the report of the scoped chat", async () => {
  const replies = [];
  const handler = createTelegramUsageCommandHandler({
    authorize: async () => ({ ok: true }),
    contextRoute: () => ({ scopeChatId: 7 }),
    agentManager: { modelUsage: { list: async (chatId) => (chatId === 7 ? [run()] : []) } },
    config: { pi: { usage: { windowMs: 24 * hourMs, reportRows: 12 } } },
    logger: null
  });

  await handler({ chat: { id: -100 }, reply: async (text, options) => replies.push({ text, options }) });

  assert.match(replies[0].text, /gpt-6-astra x2 · 24 calls/);
  assert.deepEqual(replies[0].options, { parse_mode: "HTML" });
});
