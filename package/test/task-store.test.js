import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const homeDir = await mkdtemp(path.join(os.tmpdir(), "arisa-task-store-home-"));
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;

const { TaskStore } = await import("../src/core/tasks/task-store.js");
const { arisaHomeDir, tasksFile } = await import("../src/runtime/paths.js");

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

test("claims overdue tasks chronologically and records actual execution start", async () => {
  await resetHome();
  const store = new TaskStore();
  const older = new Date(Date.now() - 2_000).toISOString();
  const newer = new Date(Date.now() - 1_000).toISOString();
  await store.add({ id: "newer", kind: "agent_task", runAt: newer });
  await store.add({ id: "older", kind: "agent_task", runAt: older });

  const claimed = await store.claimDue(2);
  assert.deepEqual(claimed.map((task) => task.id), ["older", "newer"]);
  assert.ok(claimed.every((task) => task.claimedAt));
  assert.equal(claimed[0].executionStartedAt, undefined);

  const started = await store.markExecutionStarted("older");
  assert.ok(started.executionStartedAt);
});

test("recovers interrupted running tasks for retry after restart", async () => {
  await resetHome();
  const store = new TaskStore();
  const runAt = new Date(Date.now() - 1000).toISOString();

  await store.add({ id: "interrupted-once", kind: "agent_task", runAt, status: "running" });
  await store.add({
    id: "claimed-not-started",
    kind: "agent_task",
    runAt,
    status: "running",
    attempts: 1,
    claimedAt: new Date().toISOString()
  });
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

  assert.deepEqual(recovered.map((task) => task.id), ["interrupted-once", "claimed-not-started", "interrupted-recurring"]);
  assert.equal(recovered[0].status, "outcome_uncertain");
  assert.equal(recovered[1].status, "pending");
  assert.equal(recovered[1].attempts, 0);
  assert.equal(recovered[1].lastError, "execution interrupted before start");
  assert.equal(recovered[2].status, "pending");
  assert.ok(Date.parse(recovered[2].runAt) > Date.now());
  assert.equal(recovered[0].lastError, "execution interrupted before confirmation");
  assert.equal(recovered[2].lastError, "execution interrupted before confirmation");
  assert.equal((await store.get("still-pending")).status, "pending");
  assert.equal((await store.get("already-done")).status, "done");

  const restartedStore = new TaskStore();
  assert.deepEqual(
    (await restartedStore.claimDue()).map((task) => task.id),
    ["claimed-not-started", "still-pending"]
  );
});

test("persists auth blocks, claims only due probes, and clears the block after success", async () => {
  await resetHome();
  const store = new TaskStore();
  await store.add({
    id: "auth-poll",
    kind: "poll_tool",
    runAt: new Date(Date.now() - 1000).toISOString(),
    payload: { toolName: "checker", args: { action: "poll" } },
    recurrence: { type: "interval", everySeconds: 60 }
  });

  await store.claimDue();
  const blocked = await store.blockAuth("auth-poll", "authentication expired", {
    retryAfterSeconds: 3600,
    probeArgs: { action: "auth-status" },
    toolName: "checker"
  });
  assert.equal(blocked.status, "blocked_auth");
  assert.equal(blocked.authBlockedNew, true);
  assert.deepEqual(blocked.authBlock.probeArgs, { action: "auth-status" });
  assert.equal(blocked.authBlock.toolName, "checker");
  assert.deepEqual(await store.claimDue(), []);

  store.tasks.find((task) => task.id === "auth-poll").runAt = new Date(Date.now() - 1000).toISOString();
  await store.save();
  const [probe] = await store.claimDue();
  assert.equal(probe.status, "running");
  assert.ok(probe.authBlock);

  const completed = await store.complete("auth-poll");
  assert.equal(completed.status, "pending");
  assert.equal(completed.authBlock, undefined);
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

test("compacts terminal payloads while preserving routing and audit identifiers", async () => {
  await resetHome();
  const store = new TaskStore();
  const route = { transport: "telegram", destination: { chatId: -1001, threadId: 87 } };
  const payload = {
    chatId: "chat-1",
    prompt: "private operational prompt ".repeat(200),
    args: { cursor: "large private state".repeat(100) },
    acknowledgement: "received",
    toolName: "checker",
    resourceId: "inbox:primary",
    artifactId: "artifact-1"
  };
  await store.add({ id: "compact-done", kind: "agent_task", payload, route });
  await store.add({ id: "compact-failed", kind: "agent_task", payload });
  await store.add({ id: "compact-uncertain", kind: "agent_task", payload });

  const done = await store.complete("compact-done");
  const failed = await store.fail("compact-failed", "permanent failure");
  const uncertain = await store.retryOrFail("compact-uncertain", "unknown outcome", {
    retryable: false,
    outcomeUncertain: true
  });
  const expectedPayload = {
    chatId: "chat-1",
    toolName: "checker",
    resourceId: "inbox:primary",
    artifactId: "artifact-1"
  };

  for (const task of [done, failed, uncertain]) {
    assert.deepEqual(task.payload, expectedPayload);
    assert.equal(task.payloadCompacted, true);
    assert.equal(task.retry, undefined);
    assert.equal(task.recurrence, undefined);
  }
  assert.deepEqual(done.route, route);
  assert.ok(done.completedAt);
  assert.equal(failed.error, "permanent failure");
  assert.ok(uncertain.uncertainAt);
  assert.deepEqual(
    (await store.list({ chatId: "chat-1" })).map((task) => task.id),
    ["compact-done", "compact-failed", "compact-uncertain"]
  );
});

test("startup recovery compacts historical terminal tasks without changing active payloads", async () => {
  await resetHome();
  await mkdir(path.dirname(tasksFile), { recursive: true });
  await writeFile(tasksFile, `${JSON.stringify([
    {
      id: "historical-done",
      kind: "agent_task",
      status: "done",
      payload: { chatId: "chat-1", prompt: "obsolete prompt", args: { large: "value" } },
      retry: { maxAttempts: 3 },
      recurrence: null
    },
    {
      id: "active-pending",
      kind: "agent_task",
      status: "pending",
      runAt: new Date(Date.now() + 60_000).toISOString(),
      payload: { chatId: "chat-1", prompt: "still required" }
    }
  ], null, 2)}\n`, "utf8");

  const store = new TaskStore();
  assert.deepEqual(await store.recoverInterrupted(), []);
  const persisted = JSON.parse(await readFile(tasksFile, "utf8"));
  const historical = persisted.find((task) => task.id === "historical-done");
  const active = persisted.find((task) => task.id === "active-pending");

  assert.deepEqual(historical.payload, { chatId: "chat-1" });
  assert.equal(historical.payloadCompacted, true);
  assert.equal(historical.retry, undefined);
  assert.equal(historical.recurrence, undefined);
  assert.equal(active.payload.prompt, "still required");
  assert.ok(active.retry);
});

test("backs off known failures and fails after the attempt limit", async () => {
  await resetHome();
  const store = new TaskStore();
  const runAt = new Date(Date.now() - 1000).toISOString();
  await store.add({
    id: "retrying",
    kind: "agent_task",
    runAt,
    retry: { maxAttempts: 2, baseDelaySeconds: 1, maxDelaySeconds: 10, multiplier: 2 }
  });

  await store.claimDue();
  const retrying = await store.retryOrFail("retrying", "temporary");
  assert.equal(retrying.status, "pending");
  assert.equal(retrying.attempts, 1);
  assert.ok(Date.parse(retrying.runAt) > Date.now());

  retrying.runAt = runAt;
  store.tasks.find((task) => task.id === "retrying").runAt = runAt;
  await store.save();
  await store.claimDue();
  const failed = await store.retryOrFail("retrying", "still broken");
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 2);
});

test("keeps recurring tasks scheduled after a run exhausts its retries", async () => {
  await resetHome();
  const store = new TaskStore();
  const past = new Date(Date.now() - 1000).toISOString();
  await store.add({
    id: "recurring-failure",
    kind: "agent_task",
    runAt: past,
    recurrence: { type: "interval", everySeconds: 60 },
    retry: { maxAttempts: 1 }
  });

  await store.claimDue();
  const result = await store.retryOrFail("recurring-failure", "temporary outage");

  assert.equal(result.status, "pending");
  assert.equal(result.terminalFailure, true);
  assert.equal(result.lastOutcome, "failed");
  assert.equal(result.lastError, "temporary outage");
  assert.equal(result.attempts, 0);
  assert.equal(result.consecutiveFailures, 1);
  assert.ok(Date.parse(result.runAt) > Date.now());

  const persisted = await store.get("recurring-failure");
  assert.equal(persisted.terminalFailure, undefined);
  assert.equal(persisted.status, "pending");
});

test("moves legacy Telegram routing out of task payloads", async () => {
  await resetHome();
  const store = new TaskStore();
  const task = await store.add({
    id: "routed",
    kind: "agent_task",
    payload: {
      chatId: "owner",
      telegramContext: { transportChatId: -1001, messageThreadId: 87 }
    }
  });

  assert.deepEqual(task.route, {
    transport: "telegram",
    destination: { chatId: -1001, threadId: 87 }
  });
  assert.equal(task.payload.telegramContext, undefined);
});

test("keeps recurring tasks scheduled after an uncertain outcome without replaying the occurrence", async () => {
  await resetHome();
  const store = new TaskStore();
  await store.add({
    id: "recurring-uncertain",
    kind: "agent_task",
    status: "running",
    attempts: 1,
    recurrence: { type: "interval", everySeconds: 60 }
  });

  const task = await store.retryOrFail("recurring-uncertain", "deadline exceeded", {
    retryable: false,
    outcomeUncertain: true
  });

  assert.equal(task.status, "pending");
  assert.equal(task.lastOutcome, "outcome_uncertain");
  assert.equal(task.attempts, 0);
  assert.equal(task.terminalFailure, true);
  assert.ok(Date.parse(task.runAt) > Date.now());
});

test("records uncertain outcomes without retrying", async () => {
  await resetHome();
  const store = new TaskStore();
  await store.add({ id: "uncertain", kind: "agent_task", status: "running", attempts: 1 });

  const task = await store.retryOrFail("uncertain", "turn interrupted", {
    retryable: false,
    outcomeUncertain: true
  });

  assert.equal(task.status, "outcome_uncertain");
  assert.equal(task.error, "turn interrupted");
  assert.ok(task.uncertainAt);
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
  await store.add({ id: "chat-1-uncertain", kind: "agent_task", status: "outcome_uncertain" }, { payload: { chatId: "chat-1" } });

  const removed = await store.cancelAll({ chatId: "chat-1" });
  const remaining = await store.list();

  assert.deepEqual(removed.map((task) => task.id), ["chat-1-pending"]);
  assert.deepEqual(
    remaining.map((task) => task.id),
    ["chat-2-pending", "chat-1-done", "chat-1-failed", "chat-1-uncertain"]
  );
});
