import { memoryPressureReason, readMemoryPressure } from "./memory-pressure.js";

const defaultCapacity = 2;
const defaultMaxQueuedPerClass = 100;
const defaultMinAvailableMemoryMb = 128;
const defaultMaxWorkerRssMb = 384;
const defaultMaxSwapUsedPercent = 95;
const defaultMaxToolHeapMb = 192;
const defaultMaxToolMemoryMb = 384;
const defaultMaxToolOutputBytes = 1_048_576;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? Math.min(parsed, maximum) : fallback;
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
  return {
    resourceClass,
    weight,
    deduplicateConcurrent: execution.deduplicateConcurrent === true,
    maxHeapMb: boundedInteger(execution.maxHeapMb, defaultMaxToolHeapMb, 64, 4096),
    maxMemoryMb: boundedInteger(execution.maxMemoryMb, defaultMaxToolMemoryMb, 128, 16_384),
    maxOutputBytes: boundedInteger(execution.maxOutputBytes, defaultMaxToolOutputBytes, 65_536, 16_777_216)
  };
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
    minAvailableMemoryMb: boundedInteger(policy?.minAvailableMemoryMb, defaultMinAvailableMemoryMb, 32, 65_536),
    maxWorkerRssMb: boundedInteger(policy?.maxWorkerRssMb, defaultMaxWorkerRssMb, 64, 65_536),
    maxSwapUsedPercent: boundedInteger(policy?.maxSwapUsedPercent, defaultMaxSwapUsedPercent, 1, 100),
    capacities
  };
}

function noopLease() {
  return { waitedMs: 0, release() {} };
}

export class WeightedResourceGovernor {
  constructor({
    policy,
    logger,
    now = () => Date.now(),
    memoryUsage = () => process.memoryUsage(),
    memoryPressure = readMemoryPressure
  } = {}) {
    this.policy = normalizeToolExecutionPolicy(policy);
    this.logger = logger;
    this.now = now;
    this.memoryUsage = memoryUsage;
    this.memoryPressure = memoryPressure;
    this.resources = new Map();
    this.peakRssBytes = 0;
    this.lastLoggedRssBytes = 0;
    this.lastPressure = null;
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
        this.drain(resourceClass).catch((error) => {
          this.logger?.error("tools", `could not drain ${resourceClass} queue: ${error?.message || String(error)}`);
        });
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

  async ensureAdmission(label, resourceClass) {
    const pressure = await this.memoryPressure();
    this.lastPressure = pressure;
    const reason = memoryPressureReason(pressure, this.policy);
    if (!reason) return;
    const error = new Error(`Tool ${label} was not started because ${reason}`);
    error.code = "TOOL_RESOURCE_PRESSURE";
    this.logger?.log("tools", `${label} rejected for ${resourceClass}: ${reason}`);
    throw error;
  }

  async drain(resourceClass) {
    const state = this.stateFor(resourceClass);
    if (state.draining) return;
    state.draining = true;
    try {
      const capacity = this.capacityFor(resourceClass);
      while (state.queue.length) {
        const next = state.queue[0];
        if (state.activeWeight + next.weight > capacity) break;
        state.queue.shift();
        try {
          await this.ensureAdmission(next.label, resourceClass);
          this.grant(resourceClass, next);
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      state.draining = false;
    }
  }

  async acquire(execution, label = "tool") {
    if (!execution) return noopLease();
    const resourceClass = execution.resourceClass;
    const capacity = this.capacityFor(resourceClass);
    const weight = Math.min(execution.weight, capacity);
    const state = this.stateFor(resourceClass);
    if (!state.queue.length && state.activeWeight + weight <= capacity) {
      await this.ensureAdmission(label, resourceClass);
      if (!state.queue.length && state.activeWeight + weight <= capacity) {
        return new Promise((resolve) => this.grant(resourceClass, {
          weight,
          label,
          queuedAt: this.now(),
          resolve
        }));
      }
    }
    if (state.queue.length >= this.policy.maxQueuedPerClass) {
      throw new Error(`Tool execution queue is full for resource class ${resourceClass}`);
    }
    this.logger?.log("tools", `${label} queued for ${resourceClass} capacity (${state.activeWeight}/${capacity})`);
    return new Promise((resolve, reject) => {
      state.queue.push({ weight, label, queuedAt: this.now(), resolve, reject });
    });
  }

  snapshot() {
    return {
      peakRssBytes: this.peakRssBytes,
      memoryPressure: this.lastPressure,
      resources: Object.fromEntries([...this.resources.entries()].map(([name, state]) => [name, {
        capacity: this.capacityFor(name),
        activeWeight: state.activeWeight,
        queued: state.queue.length
      }]))
    };
  }
}
