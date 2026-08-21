import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const homeDir = await mkdtemp(path.join(os.tmpdir(), "arisa-task-idempotency-home-"));
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;

const { TaskStore } = await import("../src/core/tasks/task-store.js");
const { createTaskRunner } = await import("../src/core/tasks/task-runner.js");
const { arisaHomeDir } = await import("../src/runtime/paths.js");

test("two concurrent dispatchers execute one task id exactly once", async () => {
  await rm(arisaHomeDir, { recursive: true, force: true });
  const seedStore = new TaskStore();
  await seedStore.add({
    id: "single-execution",
    kind: "agent_task",
    runAt: new Date(Date.now() - 1_000).toISOString()
  });

  const executions = [];
  const dispatch = async (task) => {
    executions.push(task.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const first = createTaskRunner({ taskStore: new TaskStore(), dispatch });
  const second = createTaskRunner({ taskStore: new TaskStore(), dispatch });

  const results = (await Promise.all([
    first.dispatchDueTasks(),
    second.dispatchDueTasks()
  ])).flat();

  assert.deepEqual(executions, ["single-execution"]);
  assert.deepEqual(results, [{ taskId: "single-execution", status: "completed" }]);
  assert.equal((await new TaskStore().get("single-execution")).status, "done");
});
