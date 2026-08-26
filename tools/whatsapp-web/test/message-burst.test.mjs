import assert from "node:assert/strict";
import test from "node:test";
import { burstBypassNames, createMessageBurstCoordinator, explicitlyInvokesBypassName } from "../message-burst.js";

function harness() {
  const states = new Map();
  const enqueued = [];
  const timers = new Map();
  let clock = 1_000;
  let timerId = 0;
  const coordinator = createMessageBurstCoordinator({
    readState: async (chatId) => structuredClone(states.get(chatId) || { bursts: {} }),
    writeState: async (chatId, state) => { states.set(chatId, structuredClone(state)); },
    enqueue: async (chatId, items, metadata) => { enqueued.push({ chatId, items, metadata }); },
    windowMs: 4_000,
    bypassNames: ["peter"],
    now: () => clock,
    setTimer(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); }
  });
  return {
    coordinator,
    enqueued,
    timers,
    advance(ms) { clock += ms; },
    async fireLatest() {
      const [id, timer] = [...timers.entries()].at(-1);
      timers.delete(id);
      await timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

function message(id, body) {
  return { id, from: "group@g.us", body, receivedAt: new Date().toISOString(), type: "chat" };
}

test("recognizes explicit configured invocations without substring false positives", () => {
  assert.deepEqual(burstBypassNames(" Peter, Arisa "), ["peter", "arisa"]);
  assert.equal(explicitlyInvokesBypassName("peter, mirá esto", ["peter"]), true);
  assert.equal(explicitlyInvokesBypassName("petersburgo", ["peter"]), false);
});

test("coalesces one same-chat burst and preserves chronological messages", async () => {
  const run = harness();
  await run.coordinator.add(7, message("a", "uno"));
  await run.coordinator.add(7, message("b", "dos"));
  assert.equal(run.enqueued.length, 0);
  assert.equal(run.timers.size, 1);

  run.advance(4_000);
  await run.fireLatest();
  assert.equal(run.enqueued.length, 1);
  assert.deepEqual(run.enqueued[0].items.map((item) => item.message.id), ["a", "b"]);
  assert.equal(run.enqueued[0].metadata.mode, "window");
  assert.equal(run.enqueued[0].metadata.enqueuedAt - run.enqueued[0].metadata.firstAt, 4_000);
});

test("an explicit Peter invocation flushes the complete pending burst immediately", async () => {
  const run = harness();
  await run.coordinator.add(7, message("a", "te paso contexto"));
  const result = await run.coordinator.add(7, message("b", "Peter, ¿qué opinás?"));

  assert.deepEqual(result, { bypassed: true, count: 2 });
  assert.equal(run.timers.size, 0);
  assert.deepEqual(run.enqueued[0].items.map((item) => item.message.id), ["a", "b"]);
  assert.equal(run.enqueued[0].metadata.mode, "bypass");
  assert.equal(run.enqueued[0].metadata.enqueuedAt - run.enqueued[0].metadata.bypassAt, 0);
});
