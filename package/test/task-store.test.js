import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const homeDir = await mkdtemp(path.join(os.tmpdir(), "arisa-task-store-home-"));
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;

const { TaskStore } = await import("../src/core/tasks/task-store.js");
const { arisaHomeDir } = await import("../src/runtime/paths.js");

async function resetHome() {
  await rm(arisaHomeDir, { recursive: true, force: true });
}

test("adds tasks and lists them by chat, status, and kind", async () => {
  await resetHome();
  const store = new TaskStore();

  await store.add({ id: "chat-1-pending", kind: "agent_task" }, { payload: { chatId: "chat-1" } });
  await store.add({ id: "chat-1-event", kind: "agent_event" }, { payload: { chatId: "chat-1" } });
  await store.add({ id: "chat-2-pending", kind: "agent_task" }, { payload: { chatId: "chat-2" } });

  assert.deepEqual(
    (await store.list({ chatId: "chat-1" })).map((task) => task.id),
    ["chat-1-pending", "chat-1-event"]
  );
  assert.deepEqual(
    (await store.list({ kind: "agent_task" })).map((task) => task.id),
    ["chat-1-pending", "chat-2-pending"]
  );
  assert.deepEqual(
    (await store.list({ status: "pending" })).map((task) => task.id),
    ["chat-1-pending", "chat-1-event", "chat-2-pending"]
  );
});

test("claims only due pending tasks and marks them running", async () => {
  await resetHome();
  const store = new TaskStore();
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();

  await store.add({ id: "due-1", kind: "agent_task", runAt: past });
  await store.add({ id: "due-2", kind: "agent_task", runAt: past });
  await store.add({ id: "future", kind: "agent_task", runAt: future });
  await store.add({ id: "done", kind: "agent_task", runAt: past, status: "done" });
  await store.add({ id: "invalid", kind: "agent_task", runAt: "not-a-date" });

  const claimed = await store.claimDue(1);

  assert.deepEqual(claimed.map((task) => task.id), ["due-1"]);
  assert.equal(claimed[0].status, "running");
  assert.equal((await store.get("due-1")).status, "running");
  assert.equal((await store.get("due-2")).status, "pending");
  assert.equal((await store.get("future")).status, "pending");
  assert.equal((await store.get("done")).status, "done");
});

test("recovers interrupted running tasks for retry after restart", async () => {
  await resetHome();
  const store = new TaskStore();
  const runAt = new Date(Date.now() - 1000).toISOString();

  await store.add({ id: "interrupted-once", kind: "agent_task", runAt, status: "running" });
  await store.add({
    id: "interrupted-recurring",
    kind: "poll_tool",
    runAt,
    status: "running",
    recurrence: { type: "interval", everySeconds: 60 }
  });
  await store.add({ id: "still-pending", kind: "agent_task", runAt });
  await store.add({ id: "already-done", kind: "agent_task", runAt, status: "done" });

  const recovered = await store.recoverInterrupted();

  assert.deepEqual(recovered.map((task) => task.id), ["interrupted-once", "interrupted-recurring"]);
  assert.ok(recovered.every((task) => task.status === "pending"));
  assert.ok(recovered.every((task) => task.runAt === runAt));
  assert.equal((await store.get("still-pending")).status, "pending");
  assert.equal((await store.get("already-done")).status, "done");

  const restartedStore = new TaskStore();
  assert.deepEqual(
    (await restartedStore.claimDue()).map((task) => task.id),
    ["interrupted-once", "interrupted-recurring", "still-pending"]
  );
});

test("completes one-off tasks and re-schedules recurring interval tasks", async () => {
  await resetHome();
  const store = new TaskStore();
  const past = new Date(Date.now() - 1000).toISOString();

  await store.add({ id: "once", kind: "agent_task", status: "running" });
  await store.add({
    id: "repeat",
    kind: "poll_tool",
    status: "running",
    runAt: past,
    recurrence: { type: "interval", everySeconds: 60 }
  });

  const once = await store.complete("once");
  const repeat = await store.complete("repeat");

  assert.equal(once.status, "done");
  assert.ok(once.completedAt);
  assert.equal(repeat.status, "pending");
  assert.ok(Date.parse(repeat.runAt) > Date.now());
  assert.ok(repeat.lastRunAt);
});

test("fails and cancels tasks by id", async () => {
  await resetHome();
  const store = new TaskStore();

  await store.add({ id: "will-fail", kind: "agent_task" });
  await store.add({ id: "will-cancel", kind: "agent_task" });

  const failed = await store.fail("will-fail", "boom");
  const canceled = await store.cancel("will-cancel");

  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "boom");
  assert.equal(canceled.id, "will-cancel");
  assert.equal(await store.get("will-cancel"), null);
});

test("cancelAll preserves done and failed tasks and respects chat filters", async () => {
  await resetHome();
  const store = new TaskStore();

  await store.add({ id: "chat-1-pending", kind: "agent_task" }, { payload: { chatId: "chat-1" } });
  await store.add({ id: "chat-2-pending", kind: "agent_task" }, { payload: { chatId: "chat-2" } });
  await store.add({ id: "chat-1-done", kind: "agent_task", status: "done" }, { payload: { chatId: "chat-1" } });
  await store.add({ id: "chat-1-failed", kind: "agent_task", status: "failed" }, { payload: { chatId: "chat-1" } });

  const removed = await store.cancelAll({ chatId: "chat-1" });
  const remaining = await store.list();

  assert.deepEqual(removed.map((task) => task.id), ["chat-1-pending"]);
  assert.deepEqual(
    remaining.map((task) => task.id),
    ["chat-2-pending", "chat-1-done", "chat-1-failed"]
  );
});
