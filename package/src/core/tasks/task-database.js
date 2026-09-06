import { chmodSync, mkdirSync, readFileSync, closeSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tasksDatabaseFile, tasksFile } from "../../platform/paths.js";

function createPrivateFile(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    closeSync(openSync(file, "wx", 0o600));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  chmodSync(file, 0o600);
}

function legacyTasks(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const tasks = JSON.parse(text);
  if (!Array.isArray(tasks)) throw new Error("Legacy task storage must contain an array");
  return tasks;
}

function taskValues(task) {
  if (!task || typeof task.id !== "string" || !task.id || typeof task.status !== "string") {
    throw new Error("Invalid task identity or status");
  }
  return [task.id, task.status, String(task.payload?.chatId ?? ""), task.kind ?? null,
    Number.isFinite(Date.parse(task.runAt)) ? Date.parse(task.runAt) : null,
    Number.isFinite(Date.parse(task.createdAt)) ? Date.parse(task.createdAt) : 0,
    JSON.stringify(task)];
}

export function insertTask(db, task) {
  db.prepare("INSERT INTO tasks (id, status, chat_id, kind, run_at, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(...taskValues(task));
}

export function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function initialize(db, legacyFile, migrate) {
  const version = () => db.prepare("PRAGMA user_version").get().user_version;
  if (version() === 1) return;
  if (version() !== 0) throw new Error("Unsupported task database version");
  transaction(db, () => {
    if (version() !== 0) return;
    db.exec(`CREATE TABLE tasks (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
      chat_id TEXT NOT NULL, kind TEXT, run_at INTEGER, created_at INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX tasks_due ON tasks(run_at, created_at, id) WHERE status IN ('pending', 'blocked_auth');
    CREATE INDEX tasks_chat ON tasks(chat_id, status);
    CREATE INDEX tasks_status ON tasks(status);`);
    for (const task of legacyTasks(legacyFile)) insertTask(db, migrate(task));
    db.exec("PRAGMA user_version = 1");
  });
}

// All work is synchronous inside a connection/transaction. No lock is held across
// an await; separate processes use SQLite locking, not an in-process promise queue.
export function withTaskDatabase(migrate, operation, {
  databaseFile = tasksDatabaseFile, legacyFile = tasksFile
} = {}) {
  createPrivateFile(databaseFile);
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA cache_size = -1024; PRAGMA mmap_size = 0; PRAGMA synchronous = FULL");
    initialize(db, legacyFile, migrate);
    return operation(db);
  } catch (error) {
    throw new Error(`Task storage operation failed: ${databaseFile}`, { cause: error });
  } finally {
    db.close();
  }
}

export function selectTasks(db, filter = {}) {
  if (filter.empty) return [];
  const conditions = [];
  const values = [];
  for (const [key, column] of [["id", "id"], ["chatId", "chat_id"], ["status", "status"], ["kind", "kind"]]) {
    if (filter[key]) {
      conditions.push(`${column} = ?`);
      values.push(String(filter[key]));
    }
  }
  let order = "seq";
  let limit = "";
  if (filter.due) {
    conditions.push("status IN ('pending', 'blocked_auth')", "run_at <= ?");
    values.push(filter.due.now);
    order = "run_at, created_at, id";
    limit = " LIMIT ?";
    values.push(filter.due.limit);
  }
  return db.prepare(`SELECT data FROM tasks ${filter.due ? "INDEXED BY tasks_due" : ""} ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY ${order}${limit}`)
    .all(...values).map((row) => JSON.parse(row.data));
}

export function persistTaskChanges(db, before, tasks) {
  const remaining = new Set(tasks.map((task) => task.id));
  for (const id of before.keys()) {
    if (!remaining.has(id)) db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }
  for (const task of tasks) {
    if (!before.has(task.id)) insertTask(db, task);
    else if (before.get(task.id) !== JSON.stringify(task)) {
      const [id, ...values] = taskValues(task);
      db.prepare("UPDATE tasks SET status = ?, chat_id = ?, kind = ?, run_at = ?, created_at = ?, data = ? WHERE id = ?")
        .run(...values, id);
    }
  }
}
