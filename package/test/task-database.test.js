import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TaskStore } from "../src/core/tasks/task-store.js";

const execute = promisify(execFile);

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "arisa-task-db-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = { databaseFile: path.join(dir, "tasks.sqlite"), legacyFile: path.join(dir, "tasks.json") };
  return { storage, store: new TaskStore(storage) };
}

function causes(error) {
  return `${error.message} ${error.cause ? causes(error.cause) : ""}`;
}

test("task migration is atomic, retains the legacy source and does not reimport it", async (t) => {
  const { storage, store } = await fixture(t);
  const text = JSON.stringify([
    { id: "old", status: "blocked_auth", kind: "agent_task", payload: { chatId: "owner", prompt: "private", telegramContext: { transportChatId: -100, messageThreadId: 87 } }, authBlock: { retryAfterSeconds: 3600 } }
  ]);
  await writeFile(storage.legacyFile, text);
  await store.init();
  assert.equal(await readFile(storage.legacyFile, "utf8"), text);
  const task = await store.get("old");
  assert.equal(task.payload.prompt, "private");
  assert.equal(task.route.destination.threadId, 87);
  assert.equal(task.authBlock.retryAfterSeconds, 3600);
  if (process.platform !== "win32") assert.equal((await stat(storage.databaseFile)).mode & 0o777, 0o600);
  await store.cancel("old");
  await writeFile(storage.legacyFile, "broken obsolete source");
  assert.deepEqual(await new TaskStore(storage).list(), []);
});

test("bad legacy task storage fails explicitly and rolls back partial migration", async (t) => {
  const { storage, store } = await fixture(t);
  for (const text of ["{broken", "{}", '[{"id":"one","status":"pending"},{"id":"one","status":"pending"}]', '[{"id":"one","status":"pending"},{}]']) {
    await writeFile(storage.legacyFile, text);
    await assert.rejects(store.init(), /Task storage operation failed/);
    assert.equal(await readFile(storage.legacyFile, "utf8"), text);
    const db = new DatabaseSync(storage.databaseFile);
    try {
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'tasks'").get().n, 0);
    } finally { db.close(); }
  }
  await writeFile(storage.legacyFile, "[]");
  await store.add({ id: "fixed", kind: "agent_task" });
  assert.equal((await store.list()).length, 1);
});

test("SQLite corruption and unsupported schemas do not silently fall back to JSON", async (t) => {
  const { storage, store } = await fixture(t);
  await writeFile(storage.databaseFile, "not a sqlite database");
  await assert.rejects(store.list(), /Task storage operation failed/);
  await rm(storage.databaseFile);
  await store.init();
  const db = new DatabaseSync(storage.databaseFile);
  db.exec("PRAGMA user_version = 999");
  db.close();
  await assert.rejects(store.list(), (error) => /Unsupported task database version/.test(causes(error)));
});

test("task writes roll back together and unrelated history is not parsed on the claim path", async (t) => {
  const { storage, store } = await fixture(t);
  await store.add({ id: "history", kind: "agent_task", status: "done" });
  await assert.rejects(store.addMany([{ id: "duplicate" }, { id: "duplicate" }]));
  assert.equal(await store.get("duplicate"), null);
  await store.add({ id: "active", kind: "agent_task", runAt: new Date(0).toISOString() });
  const db = new DatabaseSync(storage.databaseFile);
  db.prepare("UPDATE tasks SET data = ? WHERE id = ?").run("invalid JSON deliberately outside the hot path", "history");
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT data FROM tasks INDEXED BY tasks_due WHERE status IN ('pending','blocked_auth') AND run_at <= ? ORDER BY run_at, created_at, id LIMIT ?").all(Date.now(), 10);
  assert.ok(plan.some((row) => row.detail.includes("tasks_due")));
  db.close();
  assert.deepEqual((await store.claimDue()).map((task) => task.id), ["active"]);
  assert.equal((await store.complete("active")).status, "done");
  await assert.rejects(store.get("history"), /Task storage operation failed/);
});

test("idle task polling stays within a 32 MiB heap with a large terminal history and does not rewrite it", async (t) => {
  const { storage, store } = await fixture(t);
  await store.init();
  const db = new DatabaseSync(storage.databaseFile);
  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO tasks (id, status, chat_id, created_at, data) VALUES (?, 'done', 'owner', 0, ?)");
    for (let i = 0; i < 6000; i++) {
      insert.run(`history-${i}`, JSON.stringify({ id: `history-${i}`, status: "done", error: "x".repeat(10000) }));
    }
    db.exec("COMMIT");
  } finally { db.close(); }
  const before = await stat(storage.databaseFile);
  const moduleUrl = new URL("../src/core/tasks/task-store.js", import.meta.url).href;
  const { stdout } = await execute(process.execPath, ["--max-old-space-size=32", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { TaskStore } from ${JSON.stringify(moduleUrl)};
    const store = new TaskStore(${JSON.stringify(storage)});
    for (let i = 0; i < 200; i++) assert.deepEqual(await store.claimDue(), []);
    console.log('ok');
  `], { timeout: 30000 });
  assert.equal(stdout.trim(), "ok");
  const after = await stat(storage.databaseFile);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("separate processes cannot claim the same task or overwrite concurrent additions", async (t) => {
  const { storage, store } = await fixture(t);
  await store.addMany(Array.from({ length: 24 }, (_, i) => ({ id: `due-${i}`, kind: "agent_task", runAt: new Date(0).toISOString() })));
  const moduleUrl = new URL("../src/core/tasks/task-store.js", import.meta.url).href;
  const workers = await Promise.all(Array.from({ length: 4 }, (_, i) => execute(process.execPath, ["--input-type=module", "-e", `
    import { TaskStore } from ${JSON.stringify(moduleUrl)};
    const store = new TaskStore(${JSON.stringify(storage)});
    const claimed = await store.claimDue(8);
    await store.add({ id: 'worker-${i}', kind: 'agent_task', runAt: new Date(Date.now()+60000).toISOString() });
    console.log(JSON.stringify(claimed.map(t => t.id)));
  `], { timeout: 15000 })));
  const claimed = workers.flatMap(({ stdout }) => JSON.parse(stdout));
  assert.equal(claimed.length, 24);
  assert.equal(new Set(claimed).size, 24);
  assert.equal((await store.list()).length, 28);
  assert.equal((await store.list({ status: "running" })).length, 24);
});
