function normalizedPriority(value) {
  if (value === "interactive") return 10;
  if (value === "background") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(-100, Math.min(100, parsed)) : 0;
}

function positiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(max, parsed) : fallback;
}

function queueExpiredError(label) {
  const error = new Error(`${label || "Agent turn"} expired while waiting for exclusive execution.`);
  error.code = "AGENT_TURN_QUEUE_EXPIRED";
  error.retryable = true;
  error.outcomeUncertain = false;
  return error;
}

export class AgentTurnCoordinator {
  constructor({ config = {}, logger = null, now = Date.now } = {}) {
    this.logger = logger;
    this.now = now;
    this.queue = [];
    this.active = null;
    this.sequence = 0;
    this.closed = false;
    this.completed = 0;
    this.expired = 0;
    this.maxObservedQueue = 0;
    this.totalWaitMs = 0;
    this.setConfig(config);
  }

  setConfig(config = {}) {
    this.config = {
      enabled: config.enabled !== false,
      backgroundQueueTtlMs: positiveInteger(config.backgroundQueueTtlMs, 10 * 60_000, 60 * 60_000),
      interactiveQueueTtlMs: positiveInteger(config.interactiveQueueTtlMs, 0, 60 * 60_000),
      maxQueued: Math.max(1, positiveInteger(config.maxQueued, 100, 1_000))
    };
  }

  queueTtlMs(priority, override) {
    if (override != null) return positiveInteger(override, 0, 60 * 60_000);
    return priority === "interactive" ? this.config.interactiveQueueTtlMs : this.config.backgroundQueueTtlMs;
  }

  describeActive(entry) {
    if (!entry) return null;
    return { label: entry.label, priority: entry.priorityName, startedAt: entry.startedAt };
  }

  diagnostic() {
    return {
      enabled: this.config.enabled,
      active: this.describeActive(this.active),
      queued: this.queue.length,
      maxObservedQueue: this.maxObservedQueue,
      completed: this.completed,
      expired: this.expired,
      averageWaitMs: this.completed ? Math.round(this.totalWaitMs / this.completed) : 0
    };
  }

  remove(entry) {
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
  }

  next() {
    if (this.active || this.closed || !this.queue.length) return;
    this.queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
    const entry = this.queue.shift();
    if (entry.timer) clearTimeout(entry.timer);
    entry.startedAt = new Date(this.now()).toISOString();
    this.active = entry;
    const waitMs = Math.max(0, this.now() - entry.queuedAt);
    this.totalWaitMs += waitMs;
    if (waitMs > 0) this.logger?.log("agent", `${entry.label} waited ${waitMs}ms for exclusive agent execution`);
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      if (this.active === entry) this.active = null;
      this.completed += 1;
      queueMicrotask(() => this.next());
    });
  }

  acquire({ priority: priorityName = "background", label = "Agent turn", queueTtlMs } = {}) {
    if (!this.config.enabled) return Promise.resolve(() => {});
    if (this.closed) return Promise.reject(Object.assign(new Error("Agent turn coordinator is closed."), { retryable: true }));
    if (this.queue.length >= this.config.maxQueued) {
      return Promise.reject(Object.assign(new Error("Agent turn queue is full."), { code: "AGENT_TURN_QUEUE_FULL", retryable: true }));
    }
    const priority = normalizedPriority(priorityName);
    const ttlMs = this.queueTtlMs(priorityName, queueTtlMs);
    return new Promise((resolve, reject) => {
      const entry = {
        label: String(label || "Agent turn").slice(0, 160),
        priorityName: priorityName === "interactive" ? "interactive" : "background",
        priority,
        sequence: this.sequence += 1,
        queuedAt: this.now(),
        startedAt: null,
        resolve,
        reject,
        timer: null
      };
      if (ttlMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.active === entry) return;
          this.remove(entry);
          this.expired += 1;
          reject(queueExpiredError(entry.label));
        }, ttlMs);
        entry.timer.unref?.();
      }
      this.queue.push(entry);
      this.maxObservedQueue = Math.max(this.maxObservedQueue, this.queue.length);
      this.next();
    });
  }

  async run(options, work) {
    const release = await this.acquire(options);
    try {
      return await work();
    } finally {
      release();
    }
  }

  close() {
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error("Agent turn coordinator closed before execution."), { retryable: true }));
    }
  }
}
