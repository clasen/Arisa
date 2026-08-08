import test from "node:test";
import assert from "node:assert/strict";
import { acknowledgeSecretaryMessages, selectSecretaryWake } from "../secretary-state.js";

test("new messages wake and receive a retry lease", () => {
  const now = "2026-08-08T12:00:00.000Z";
  const first = selectSecretaryWake([{ id: "m1", threadId: "t1" }], {}, { now, retrySeconds: 600 });
  assert.deepEqual(first.selected.map((item) => item.id), ["m1"]);
  const early = selectSecretaryWake([{ id: "m1", threadId: "t1" }], first.state, { now: "2026-08-08T12:05:00.000Z", retrySeconds: 600 });
  assert.equal(early.selected.length, 0);
  const retry = selectSecretaryWake([{ id: "m1", threadId: "t1" }], early.state, { now: "2026-08-08T12:11:00.000Z", retrySeconds: 600 });
  assert.deepEqual(retry.selected.map((item) => item.id), ["m1"]);
  assert.equal(retry.selected[0].wakeCount, 2);
});

test("acknowledged messages never wake again", () => {
  const first = selectSecretaryWake([{ id: "m1", threadId: "t1" }], {}, { now: "2026-08-08T12:00:00.000Z" });
  const ack = acknowledgeSecretaryMessages(first.state, ["m1"], "replied", "2026-08-08T12:01:00.000Z");
  const later = selectSecretaryWake([{ id: "m1", threadId: "t1" }], ack.state, { now: "2026-08-09T12:00:00.000Z" });
  assert.equal(later.selected.length, 0);
  assert.equal(later.state.messages.m1.disposition, "replied");
});

test("read messages are not suppressed because selection is query-driven", () => {
  const result = selectSecretaryWake([{ id: "read-reply", threadId: "thread" }], { ids: ["read-reply"] }, { now: "2026-08-08T12:00:00.000Z" });
  assert.deepEqual(result.selected.map((item) => item.id), ["read-reply"]);
});

test("wake batches are bounded without losing later candidates", () => {
  const result = selectSecretaryWake([{ id: "a" }, { id: "b" }, { id: "c" }], {}, { now: "2026-08-08T12:00:00.000Z", maxWake: 2 });
  assert.deepEqual(result.selected.map((item) => item.id), ["a", "b"]);
  assert.equal(result.state.messages.c.wakeCount, undefined);
});

test("only the newest matching message in a thread wakes", () => {
  const result = selectSecretaryWake([
    { id: "newest", threadId: "thread" },
    { id: "older", threadId: "thread" }
  ], {}, { now: "2026-08-08T12:00:00.000Z" });
  assert.deepEqual(result.selected.map((item) => item.id), ["newest"]);
  assert.equal(result.state.messages.older.disposition, "superseded");
  assert.equal(result.state.messages.older.supersededBy, "newest");
});

test("a later reply in an acknowledged thread still wakes", () => {
  const previous = acknowledgeSecretaryMessages({}, ["old"], "replied", "2026-08-08T12:00:00.000Z").state;
  previous.messages.old.threadId = "thread";
  const result = selectSecretaryWake([
    { id: "new", threadId: "thread" },
    { id: "old", threadId: "thread" }
  ], previous, { now: "2026-08-09T12:00:00.000Z" });
  assert.deepEqual(result.selected.map((item) => item.id), ["new"]);
});
