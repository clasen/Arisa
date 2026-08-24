const defaultCapacity = 2;
const defaultMaxQueuedPerClass = 100;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resourceClassName(value) {
  const name = String(value || "").trim();
  if (!name) return "";
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new Error(`Invalid tool execution resource class: ${name}`);
  }
  return name;
}

export function normalizeToolExecution(execution) {
  if (execution == null) return null;
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    throw new Error("Tool execution policy must be an object");
  }
  const resourceClass = resourceClassName(execution.resourceClass);
  if (!resourceClass) throw new Error("Tool execution resourceClass is required");
  const weight = positiveInteger(execution.weight, 0);
  if (!weight) throw new Error("Tool execution weight must be a positive integer");
  return { resourceClass, weight };
}

export function normalizeToolExecutionPolicy(policy = {}) {
  const configuredCapacities = policy?.capacities && typeof policy.capacities === "object" && !Array.isArray(policy.capacities)
    ? policy.capacities
    : {};
  const capacities = {};
  for (const [name, value] of Object.entries(configuredCapacities)) {
    capacities[resourceClassName(name)] = positiveInteger(value, defaultCapacity);
  }
  return {
    defaultCapacity: positiveInteger(policy?.defaultCapacity, defaultCapacity),
    maxQueuedPerClass: positiveInteger(policy?.maxQueuedPerClass, defaultMaxQueuedPerClass),
    capacities
  };
}

function noopLease() {
  return { waitedMs: 0, release() {} };
}

export class WeightedResourceGovernor {
  constructor({ policy, logger, now = () => Date.now(), memoryUsage = () => process.memoryUsage() } = {}) {
    this.policy = normalizeToolExecutionPolicy(policy);
    this.logger = logger;
    this.now = now;
    this.memoryUsage = memoryUsage;
    this.resources = new Map();
    this.peakRssBytes = 0;
    this.lastLoggedRssBytes = 0;
  }

  capacityFor(resourceClass) {
    return this.policy.capacities[resourceClass] || this.policy.defaultCapacity;
  }

  stateFor(resourceClass) {
    let state = this.resources.get(resourceClass);
    if (!state) {
      state = { activeWeight: 0, queue: [] };
      this.resources.set(resourceClass, state);
    }
    return state;
  }

  observeMemory(resourceClass) {
    const rss = Number(this.memoryUsage()?.rss) || 0;
    if (rss <= this.peakRssBytes) return;
    this.peakRssBytes = rss;
    const logStepBytes = 8 * 1024 * 1024;
    if (this.lastLoggedRssBytes && rss - this.lastLoggedRssBytes < logStepBytes) return;
    this.lastLoggedRssBytes = rss;
    this.logger?.log("tools", `worker RSS peak ${Math.ceil(rss / 1024 / 1024)} MiB while using ${resourceClass}`);
  }

  createLease(resourceClass, weight, waitedMs) {
    let released = false;
    return {
      waitedMs,
      release: () => {
        if (released) return;
        released = true;
        const state = this.stateFor(resourceClass);
        state.activeWeight = Math.max(0, state.activeWeight - weight);
        this.observeMemory(resourceClass);
        this.drain(resourceClass);
      }
    };
  }

  grant(resourceClass, request) {
    const state = this.stateFor(resourceClass);
    state.activeWeight += request.weight;
    const waitedMs = Math.max(0, this.now() - request.queuedAt);
    this.observeMemory(resourceClass);
    if (waitedMs > 0) {
      this.logger?.log("tools", `${request.label} acquired ${resourceClass} capacity after ${waitedMs}ms`);
    }
    request.resolve(this.createLease(resourceClass, request.weight, waitedMs));
  }

  drain(resourceClass) {
    const state = this.stateFor(resourceClass);
    const capacity = this.capacityFor(resourceClass);
    while (state.queue.length) {
      const next = state.queue[0];
      if (state.activeWeight + next.weight > capacity) break;
      state.queue.shift();
      this.grant(resourceClass, next);
    }
  }

  acquire(execution, label = "tool") {
    if (!execution) return Promise.resolve(noopLease());
    const resourceClass = execution.resourceClass;
    const capacity = this.capacityFor(resourceClass);
    const weight = Math.min(execution.weight, capacity);
    const state = this.stateFor(resourceClass);
    if (!state.queue.length && state.activeWeight + weight <= capacity) {
      return new Promise((resolve) => this.grant(resourceClass, {
        weight,
        label,
        queuedAt: this.now(),
        resolve
      }));
    }
    if (state.queue.length >= this.policy.maxQueuedPerClass) {
      throw new Error(`Tool execution queue is full for resource class ${resourceClass}`);
    }
    this.logger?.log("tools", `${label} queued for ${resourceClass} capacity (${state.activeWeight}/${capacity})`);
    return new Promise((resolve) => {
      state.queue.push({ weight, label, queuedAt: this.now(), resolve });
    });
  }

  snapshot() {
    return {
      peakRssBytes: this.peakRssBytes,
      resources: Object.fromEntries([...this.resources.entries()].map(([name, state]) => [name, {
        capacity: this.capacityFor(name),
        activeWeight: state.activeWeight,
        queued: state.queue.length
      }]))
    };
  }
}
