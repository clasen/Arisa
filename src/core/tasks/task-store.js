import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { tasksFile } from "../../runtime/paths.js";

async function loadTasksFile() {
  try {
    return JSON.parse(await readFile(tasksFile, "utf8"));
  } catch {
    return [];
  }
}

async function saveTasksFile(tasks) {
  await mkdir(path.dirname(tasksFile), { recursive: true });
  await writeFile(tasksFile, `${JSON.stringify(tasks, null, 2)}\n`, "utf8");
}

function taskId() {
  return crypto.randomUUID();
}

function normalizeTask(task, defaults = {}) {
  return {
    id: task.id || taskId(),
    status: task.status || "pending",
    createdAt: task.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    kind: task.kind,
    runAt: task.runAt,
    payload: {
      ...(defaults.payload || {}),
      ...(task.payload || {})
    },
    recurrence: task.recurrence || defaults.recurrence || null,
    source: {
      ...(defaults.source || {}),
      ...(task.source || {})
    }
  };
}

function computeNextRunAt(task) {
  if (task.recurrence?.type === "interval" && Number(task.recurrence.everySeconds) > 0) {
    return new Date(Date.now() + (Number(task.recurrence.everySeconds) * 1000)).toISOString();
  }
  return "";
}

export class TaskStore {
  constructor() {
    this.tasks = null;
  }

  async init() {
    if (!this.tasks) this.tasks = await loadTasksFile();
  }

  async reload() {
    this.tasks = await loadTasksFile();
  }

  async save() {
    await saveTasksFile(this.tasks || []);
  }

  async add(task, defaults = {}) {
    await this.init();
    const normalized = normalizeTask(task, defaults);
    this.tasks.push(normalized);
    await this.save();
    return normalized;
  }

  async addMany(tasks = [], defaults = {}) {
    const created = [];
    for (const task of tasks) {
      created.push(await this.add(task, defaults));
    }
    return created;
  }

  async claimDue(limit = 10) {
    await this.reload();
    const now = Date.now();
    const due = [];

    for (const task of this.tasks) {
      if (due.length >= limit) break;
      if (task.status !== "pending") continue;
      if (!task.runAt || Number.isNaN(Date.parse(task.runAt))) continue;
      if (Date.parse(task.runAt) > now) continue;
      task.status = "running";
      task.updatedAt = new Date().toISOString();
      due.push({ ...task });
    }

    if (due.length) await this.save();
    return due;
  }

  async complete(taskId) {
    await this.init();
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) return null;

    const nextRunAt = computeNextRunAt(task);
    if (nextRunAt) {
      task.status = "pending";
      task.runAt = nextRunAt;
      task.lastRunAt = new Date().toISOString();
    } else {
      task.status = "done";
      task.completedAt = new Date().toISOString();
    }
    task.updatedAt = new Date().toISOString();
    await this.save();
    return task;
  }

  async fail(taskId, error) {
    await this.init();
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) return null;
    task.status = "failed";
    task.error = error;
    task.updatedAt = new Date().toISOString();
    await this.save();
    return task;
  }

  async list(filter = {}) {
    await this.reload();
    return this.tasks.filter((task) => {
      if (filter.chatId && task.payload?.chatId !== filter.chatId) return false;
      if (filter.status && task.status !== filter.status) return false;
      if (filter.kind && task.kind !== filter.kind) return false;
      return true;
    });
  }

  async get(taskId) {
    await this.reload();
    return this.tasks.find((item) => item.id === taskId) || null;
  }

  async cancel(taskId) {
    await this.reload();
    const index = this.tasks.findIndex((item) => item.id === taskId);
    if (index === -1) return null;
    const [task] = this.tasks.splice(index, 1);
    await this.save();
    return task;
  }

  async cancelAll(filter = {}) {
    await this.reload();
    const removed = [];
    this.tasks = this.tasks.filter((task) => {
      if (filter.chatId && task.payload?.chatId !== filter.chatId) return true;
      if (filter.status && task.status !== filter.status) return true;
      if (task.status === "done" || task.status === "failed") return true;
      removed.push({ ...task });
      return false;
    });
    if (removed.length) await this.save();
    return removed;
  }
}
