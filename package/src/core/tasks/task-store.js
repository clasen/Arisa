import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { tasksFile } from "../../platform/paths.js";

const DEFAULT_RETRY = Object.freeze({
  maxAttempts: 3,
  baseDelaySeconds: 30,
  maxDelaySeconds: 900,
  multiplier: 2
});

const TERMINAL_STATUSES = new Set(["done", "failed", "outcome_uncertain"]);
const TERMINAL_PAYLOAD_KEYS = ["chatId", "toolName", "resourceId", "artifactId"];

const taskFileOperations = new Map();

async function serializeTaskFileOperation(operation) {
  const previous = taskFileOperations.get(tasksFile) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  taskFileOperations.set(tasksFile, current);
  try {
    return await current;
  } finally {
    if (taskFileOperations.get(tasksFile) === current) taskFileOperations.delete(tasksFile);
  }
}

async function waitForTaskFileOperations() {
  await (taskFileOperations.get(tasksFile) || Promise.resolve()).catch(() => {});
}

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
  const migrated = {
    ...task,
    payload,
    route,
    attempts: Number.isSafeInteger(task.attempts) && task.attempts >= 0 ? task.attempts : 0
  };
  if (!TERMINAL_STATUSES.has(migrated.status)) migrated.retry = normalizeRetry(task.retry);
  return migrated;
}

function compactTerminalPayload(payload = {}) {
  return Object.fromEntries(TERMINAL_PAYLOAD_KEYS.flatMap((key) => {
    const value = payload[key];
    return ["string", "number", "boolean"].includes(typeof value) ? [[key, value]] : [];
  }));
}

function compactTerminalTask(task) {
  if (!TERMINAL_STATUSES.has(task.status)) return false;
  const payload = compactTerminalPayload(task.payload);
  const changed = !task.payloadCompacted
    || JSON.stringify(task.payload || {}) !== JSON.stringify(payload)
    || Object.hasOwn(task, "retry")
    || Object.hasOwn(task, "recurrence");
  task.payload = payload;
  task.payloadCompacted = true;
  delete task.retry;
  delete task.recurrence;
  return changed;
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
  const normalized = migrateTask({
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
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.claimedAt ? { claimedAt: task.claimedAt } : {}),
    ...(task.executionStartedAt ? { executionStartedAt: task.executionStartedAt } : {}),
    attempts: task.attempts || 0,
    retry: task.retry || defaults.retry
  });
  compactTerminalTask(normalized);
  return normalized;
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

function normalizeAuthResolution(resolution = {}) {
  const value = resolution && typeof resolution === "object" && !Array.isArray(resolution) ? resolution : {};
  const retryAfterSeconds = Math.max(300, boundedPositiveNumber(value.retryAfterSeconds, 3_600, 86_400));
  const probeArgs = value.probeArgs && typeof value.probeArgs === "object" && !Array.isArray(value.probeArgs)
    ? structuredClone(value.probeArgs)
    : {};
  if (JSON.stringify(probeArgs).length > 4_096) throw new Error("Authentication probe arguments are too large");
  const toolName = typeof value.toolName === "string" ? value.toolName.trim().slice(0, 128) : "";
  return { retryAfterSeconds, probeArgs, ...(toolName ? { toolName } : {}) };
}

function failTask(task, error) {
  const failedAt = new Date().toISOString();
  task.status = "failed";
  task.error = error instanceof Error ? error.message : String(error);
  task.lastError = task.error;
  task.failedAt = failedAt;
  task.updatedAt = failedAt;
  compactTerminalTask(task);
  return structuredClone(task);
}

export class TaskStore {
  constructor() {
    this.tasks = null;
  }

  async init() {
    if (!this.tasks) await this.reload();
  }

  async reload() {
    await waitForTaskFileOperations();
    this.tasks = await loadTasksFile();
  }

  async mutate(operation) {
    return serializeTaskFileOperation(async () => {
      this.tasks = await loadTasksFile();
      const { result, changed = true } = await operation(this.tasks);
      if (changed) await saveTasksFile(this.tasks);
      return result;
    });
  }

  async save() {
    const tasks = structuredClone(this.tasks || []);
    return serializeTaskFileOperation(async () => {
      this.tasks = tasks;
      await saveTasksFile(tasks);
    });
  }

  async add(task, defaults = {}) {
    return this.mutate(async (tasks) => {
      const normalized = normalizeTask(task, defaults);
      tasks.push(normalized);
      return { result: structuredClone(normalized) };
    });
  }

  async addMany(tasksToAdd = [], defaults = {}) {
    return this.mutate(async (tasks) => {
      const created = tasksToAdd.map((task) => normalizeTask(task, defaults));
      tasks.push(...created);
      return { result: structuredClone(created), changed: created.length > 0 };
    });
  }

  async claimDue(limit = 10) {
    return this.mutate(async (tasks) => {
      const now = Date.now();
      const due = tasks
        .filter((task) => ["pending", "blocked_auth"].includes(task.status)
          && task.runAt
          && !Number.isNaN(Date.parse(task.runAt))
          && Date.parse(task.runAt) <= now)
        .sort((left, right) => Date.parse(left.runAt) - Date.parse(right.runAt)
          || Date.parse(left.createdAt || 0) - Date.parse(right.createdAt || 0)
          || String(left.id).localeCompare(String(right.id)))
        .slice(0, limit);

      const claimedAt = new Date(now).toISOString();
      for (const task of due) {
        task.status = "running";
        task.attempts += 1;
        task.startedAt = claimedAt;
        task.claimedAt = claimedAt;
        delete task.executionStartedAt;
        task.updatedAt = claimedAt;
      }

      return { result: structuredClone(due), changed: due.length > 0 };
    });
  }

  async markExecutionStarted(taskId) {
    return this.mutate(async (tasks) => {
      const task = tasks.find((item) => item.id === taskId);
      if (!task || task.status !== "running") return { result: null, changed: false };
      task.executionStartedAt = new Date().toISOString();
      task.updatedAt = task.executionStartedAt;
      return { result: structuredClone(task) };
    });
  }

  async recoverInterrupted() {
    return this.mutate(async (tasks) => {
      const recovered = [];
      let compacted = false;
      const now = Date.now();

      for (const task of tasks) {
        if (task.status === "running") {
          const interruptedAt = new Date(now).toISOString();
          if (task.claimedAt && !task.executionStartedAt) {
            task.status = task.authBlock ? "blocked_auth" : "pending";
            task.attempts = Math.max(0, Number(task.attempts || 0) - 1);
            task.lastError = "execution interrupted before start";
            task.lastFailedAt = interruptedAt;
            task.updatedAt = interruptedAt;
            task.lastClaimedAt = task.claimedAt;
            delete task.startedAt;
            delete task.claimedAt;
            recovered.push(structuredClone(task));
            continue;
          }
          task.lastError = "execution interrupted before confirmation";
          task.lastFailedAt = interruptedAt;
          task.updatedAt = interruptedAt;
          if (task.claimedAt) task.lastClaimedAt = task.claimedAt;
          if (task.executionStartedAt) task.lastExecutionStartedAt = task.executionStartedAt;
          delete task.claimedAt;
          delete task.executionStartedAt;
          if (task.kind === "poll_tool") {
            task.status = task.authBlock ? "blocked_auth" : "pending";
            const delayMs = task.authBlock
              ? Number(task.authBlock.retryAfterSeconds || 3_600) * 1_000
              : retryDelayMs(task);
            task.runAt = new Date(now + delayMs).toISOString();
            delete task.startedAt;
          } else {
            const nextRunAt = computeNextRunAt(task, now);
            if (nextRunAt) {
              task.status = "pending";
              task.runAt = nextRunAt;
              task.attempts = 0;
              task.lastOutcome = "outcome_uncertain";
              delete task.startedAt;
            } else {
              task.status = "outcome_uncertain";
              task.error = task.lastError;
            }
          }
          compactTerminalTask(task);
          recovered.push(structuredClone(task));
          continue;
        }
        if (compactTerminalTask(task)) compacted = true;
      }

      return { result: recovered, changed: recovered.length > 0 || compacted };
    });
  }

  async complete(taskId) {
    return this.mutate(async (tasks) => {
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return { result: null, changed: false };

      const now = Date.now();
      const completedAt = new Date(now).toISOString();
      const nextRunAt = computeNextRunAt(task, now);
      task.lastCompletedAt = completedAt;
      task.lastRunAt = completedAt;
      if (task.claimedAt) task.lastClaimedAt = task.claimedAt;
      if (task.executionStartedAt) task.lastExecutionStartedAt = task.executionStartedAt;
      delete task.lastError;
      delete task.error;
      delete task.lastOutcome;
      delete task.consecutiveFailures;
      delete task.authBlock;
      delete task.claimedAt;
      delete task.executionStartedAt;
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
      compactTerminalTask(task);
      return { result: structuredClone(task) };
    });
  }

  async blockAuth(taskId, error, resolution = {}) {
    return this.mutate(async (tasks) => {
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return { result: null, changed: false };
      const now = Date.now();
      const checkedAt = new Date(now).toISOString();
      const normalized = normalizeAuthResolution(resolution);
      const wasBlocked = Boolean(task.authBlock);
      task.status = "blocked_auth";
      task.runAt = new Date(now + (normalized.retryAfterSeconds * 1_000)).toISOString();
      task.attempts = 0;
      task.authBlock = {
        firstBlockedAt: task.authBlock?.firstBlockedAt || checkedAt,
        lastCheckedAt: checkedAt,
        ...normalized
      };
      task.lastError = error instanceof Error ? error.message : String(error);
      task.lastFailedAt = checkedAt;
      task.updatedAt = checkedAt;
      if (task.claimedAt) task.lastClaimedAt = task.claimedAt;
      if (task.executionStartedAt) task.lastExecutionStartedAt = task.executionStartedAt;
      delete task.startedAt;
      delete task.claimedAt;
      delete task.executionStartedAt;
      delete task.error;
      return { result: { ...structuredClone(task), authBlockedNew: !wasBlocked } };
    });
  }

  async retryOrFail(taskId, error, { retryable = true, outcomeUncertain = false } = {}) {
    return this.mutate(async (tasks) => {
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return { result: null, changed: false };
      const message = error instanceof Error ? error.message : String(error);
      if (outcomeUncertain) {
        const now = Date.now();
        const uncertainAt = new Date(now).toISOString();
        const nextRunAt = computeNextRunAt(task, now);
        task.lastError = message;
        task.lastFailedAt = uncertainAt;
        task.updatedAt = uncertainAt;
        if (task.claimedAt) task.lastClaimedAt = task.claimedAt;
        if (task.executionStartedAt) task.lastExecutionStartedAt = task.executionStartedAt;
        delete task.claimedAt;
        delete task.executionStartedAt;
        if (nextRunAt) {
          task.status = "pending";
          task.runAt = nextRunAt;
          task.attempts = 0;
          task.lastOutcome = "outcome_uncertain";
          delete task.startedAt;
          delete task.error;
          return { result: { ...structuredClone(task), terminalFailure: true } };
        }
        task.status = "outcome_uncertain";
        task.error = message;
        task.uncertainAt = uncertainAt;
        compactTerminalTask(task);
        return { result: structuredClone(task) };
      }
      if (!retryable) return { result: failTask(task, message) };
      if (task.attempts >= task.retry.maxAttempts) {
        const now = Date.now();
        const nextRunAt = computeNextRunAt(task, now);
        if (!nextRunAt) return { result: failTask(task, message) };

        const failedAt = new Date(now).toISOString();
        task.status = "pending";
        task.runAt = nextRunAt;
        task.attempts = 0;
        task.lastOutcome = "failed";
        task.lastError = message;
        task.lastFailedAt = failedAt;
        task.consecutiveFailures = Number(task.consecutiveFailures || 0) + 1;
        task.updatedAt = failedAt;
        if (task.claimedAt) task.lastClaimedAt = task.claimedAt;
        if (task.executionStartedAt) task.lastExecutionStartedAt = task.executionStartedAt;
        delete task.startedAt;
        delete task.claimedAt;
        delete task.executionStartedAt;
        delete task.error;
        return { result: { ...structuredClone(task), terminalFailure: true } };
      }

      const now = Date.now();
      task.status = "pending";
      task.runAt = new Date(now + retryDelayMs(task)).toISOString();
      task.lastError = message;
      task.lastFailedAt = new Date(now).toISOString();
      task.updatedAt = task.lastFailedAt;
      if (task.claimedAt) task.lastClaimedAt = task.claimedAt;
      if (task.executionStartedAt) task.lastExecutionStartedAt = task.executionStartedAt;
      delete task.startedAt;
      delete task.claimedAt;
      delete task.executionStartedAt;
      return { result: structuredClone(task) };
    });
  }

  async fail(taskId, error) {
    return this.mutate(async (tasks) => {
      const task = tasks.find((item) => item.id === taskId);
      return task
        ? { result: failTask(task, error) }
        : { result: null, changed: false };
    });
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
    return this.mutate(async (tasks) => {
      const index = tasks.findIndex((item) => item.id === taskId);
      if (index === -1) return { result: null, changed: false };
      const [task] = tasks.splice(index, 1);
      return { result: structuredClone(task) };
    });
  }

  async cancelAll(filter = {}) {
    return this.mutate(async (tasks) => {
      const removed = [];
      const remaining = tasks.filter((task) => {
        if (filter.chatId && String(task.payload?.chatId) !== String(filter.chatId)) return true;
        if (filter.status && task.status !== filter.status) return true;
        if (["done", "failed", "outcome_uncertain"].includes(task.status)) return true;
        removed.push(structuredClone(task));
        return false;
      });
      tasks.splice(0, tasks.length, ...remaining);
      return { result: removed, changed: removed.length > 0 };
    });
  }
}
