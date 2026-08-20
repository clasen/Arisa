import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { tasksFile } from "../../runtime/paths.js";

const DEFAULT_RETRY = Object.freeze({
  maxAttempts: 3,
  baseDelaySeconds: 30,
  maxDelaySeconds: 900,
  multiplier: 2
});

async function loadTasksFile() {
  try {
    const parsed = JSON.parse(await readFile(tasksFile, "utf8"));
    return Array.isArray(parsed) ? parsed.map(migrateTask) : [];
  } catch {
    return [];
  }
}

async function saveTasksFile(tasks) {
  await mkdir(path.dirname(tasksFile), { recursive: true });
  const temporaryFile = `${tasksFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, `${JSON.stringify(tasks, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryFile, tasksFile);
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => {});
  }
}

function taskId() {
  return crypto.randomUUID();
}

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function boundedPositiveNumber(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function normalizeRetry(retry = {}) {
  const value = retry && typeof retry === "object" && !Array.isArray(retry) ? retry : {};
  return {
    maxAttempts: boundedPositiveInteger(value.maxAttempts, DEFAULT_RETRY.maxAttempts, 10),
    baseDelaySeconds: boundedPositiveNumber(value.baseDelaySeconds, DEFAULT_RETRY.baseDelaySeconds, 3_600),
    maxDelaySeconds: boundedPositiveNumber(value.maxDelaySeconds, DEFAULT_RETRY.maxDelaySeconds, 86_400),
    multiplier: boundedPositiveNumber(value.multiplier, DEFAULT_RETRY.multiplier, 10)
  };
}

function legacyTelegramRoute(telegramContext) {
  if (!telegramContext?.transportChatId) return null;
  return {
    transport: "telegram",
    destination: {
      chatId: telegramContext.transportChatId,
      ...(telegramContext.messageThreadId ? { threadId: telegramContext.messageThreadId } : {})
    }
  };
}

function migrateTask(task = {}) {
  const payload = { ...(task.payload || {}) };
  const route = task.route || legacyTelegramRoute(payload.telegramContext) || null;
  delete payload.telegramContext;
  return {
    ...task,
    payload,
    route,
    attempts: Number.isSafeInteger(task.attempts) && task.attempts >= 0 ? task.attempts : 0,
    retry: normalizeRetry(task.retry)
  };
}

function normalizeTask(task, defaults = {}) {
  const mergedPayload = {
    ...(defaults.payload || {}),
    ...(task.payload || {})
  };
  const route = task.route
    || defaults.route
    || legacyTelegramRoute(mergedPayload.telegramContext)
    || null;
  delete mergedPayload.telegramContext;
  return migrateTask({
    id: task.id || taskId(),
    status: task.status || "pending",
    createdAt: task.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    kind: task.kind,
    runAt: task.runAt || new Date().toISOString(),
    payload: mergedPayload,
    route,
    recurrence: task.recurrence || defaults.recurrence || null,
    source: {
      ...(defaults.source || {}),
      ...(task.source || {})
    },
    attempts: task.attempts || 0,
    retry: task.retry || defaults.retry
  });
}

function computeNextRunAt(task, now = Date.now()) {
  if (task.recurrence?.type === "interval" && Number(task.recurrence.everySeconds) > 0) {
    return new Date(now + (Number(task.recurrence.everySeconds) * 1000)).toISOString();
  }
  return "";
}

function retryDelayMs(task) {
  const exponent = Math.max(0, Number(task.attempts || 1) - 1);
  const seconds = Math.min(
    task.retry.maxDelaySeconds,
    task.retry.baseDelaySeconds * (task.retry.multiplier ** exponent)
  );
  return Math.max(1, Math.round(seconds * 1000));
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
    await this.init();
    const created = tasks.map((task) => normalizeTask(task, defaults));
    this.tasks.push(...created);
    if (created.length) await this.save();
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
      task.attempts += 1;
      task.startedAt = new Date(now).toISOString();
      task.updatedAt = task.startedAt;
      due.push(structuredClone(task));
    }

    if (due.length) await this.save();
    return due;
  }

  async recoverInterrupted() {
    await this.reload();
    const recovered = [];
    const now = Date.now();

    for (const task of this.tasks) {
      if (task.status !== "running") continue;
      const interruptedAt = new Date(now).toISOString();
      task.lastError = "execution interrupted before confirmation";
      task.lastFailedAt = interruptedAt;
      task.updatedAt = interruptedAt;
      if (task.kind === "poll_tool") {
        task.status = "pending";
        task.runAt = new Date(now + retryDelayMs(task)).toISOString();
      } else {
        const nextRunAt = computeNextRunAt(task, now);
        if (nextRunAt) {
          task.status = "pending";
          task.runAt = nextRunAt;
          task.attempts = 0;
          task.lastOutcome = "outcome_uncertain";
        } else {
          task.status = "outcome_uncertain";
          task.error = task.lastError;
        }
      }
      recovered.push(structuredClone(task));
    }

    if (recovered.length) await this.save();
    return recovered;
  }

  async complete(taskId) {
    await this.init();
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) return null;

    const now = Date.now();
    const completedAt = new Date(now).toISOString();
    const nextRunAt = computeNextRunAt(task, now);
    task.lastCompletedAt = completedAt;
    task.lastRunAt = completedAt;
    delete task.lastError;
    delete task.error;
    delete task.lastOutcome;
    delete task.consecutiveFailures;
    if (nextRunAt) {
      task.status = "pending";
      task.runAt = nextRunAt;
      task.attempts = 0;
      delete task.startedAt;
    } else {
      task.status = "done";
      task.completedAt = completedAt;
    }
    task.updatedAt = completedAt;
    await this.save();
    return structuredClone(task);
  }

  async retryOrFail(taskId, error, { retryable = true, outcomeUncertain = false } = {}) {
    await this.init();
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) return null;
    const message = error instanceof Error ? error.message : String(error);
    if (outcomeUncertain) {
      const uncertainAt = new Date().toISOString();
      task.status = "outcome_uncertain";
      task.error = message;
      task.lastError = message;
      task.uncertainAt = uncertainAt;
      task.updatedAt = uncertainAt;
      await this.save();
      return structuredClone(task);
    }
    if (!retryable) return this.fail(taskId, message);
    if (task.attempts >= task.retry.maxAttempts) {
      const now = Date.now();
      const nextRunAt = computeNextRunAt(task, now);
      if (!nextRunAt) return this.fail(taskId, message);

      const failedAt = new Date(now).toISOString();
      task.status = "pending";
      task.runAt = nextRunAt;
      task.attempts = 0;
      task.lastOutcome = "failed";
      task.lastError = message;
      task.lastFailedAt = failedAt;
      task.consecutiveFailures = Number(task.consecutiveFailures || 0) + 1;
      task.updatedAt = failedAt;
      delete task.startedAt;
      delete task.error;
      await this.save();
      return { ...structuredClone(task), terminalFailure: true };
    }

    const now = Date.now();
    task.status = "pending";
    task.runAt = new Date(now + retryDelayMs(task)).toISOString();
    task.lastError = message;
    task.lastFailedAt = new Date(now).toISOString();
    task.updatedAt = task.lastFailedAt;
    await this.save();
    return structuredClone(task);
  }

  async fail(taskId, error) {
    await this.init();
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) return null;
    const failedAt = new Date().toISOString();
    task.status = "failed";
    task.error = error instanceof Error ? error.message : String(error);
    task.lastError = task.error;
    task.failedAt = failedAt;
    task.updatedAt = failedAt;
    await this.save();
    return structuredClone(task);
  }

  async list(filter = {}) {
    await this.reload();
    return this.tasks.filter((task) => {
      if (filter.chatId && String(task.payload?.chatId) !== String(filter.chatId)) return false;
      if (filter.status && task.status !== filter.status) return false;
      if (filter.kind && task.kind !== filter.kind) return false;
      return true;
    }).map((task) => structuredClone(task));
  }

  async get(taskId) {
    await this.reload();
    const task = this.tasks.find((item) => item.id === taskId);
    return task ? structuredClone(task) : null;
  }

  async cancel(taskId) {
    await this.reload();
    const index = this.tasks.findIndex((item) => item.id === taskId);
    if (index === -1) return null;
    const [task] = this.tasks.splice(index, 1);
    await this.save();
    return structuredClone(task);
  }

  async cancelAll(filter = {}) {
    await this.reload();
    const removed = [];
    this.tasks = this.tasks.filter((task) => {
      if (filter.chatId && String(task.payload?.chatId) !== String(filter.chatId)) return true;
      if (filter.status && task.status !== filter.status) return true;
      if (["done", "failed", "outcome_uncertain"].includes(task.status)) return true;
      removed.push(structuredClone(task));
      return false;
    });
    if (removed.length) await this.save();
    return removed;
  }
}
