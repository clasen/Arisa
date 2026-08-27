import { memoryPressureReason, readMemoryPressure } from "./memory-pressure.js";

const defaultCapacity = 2;
const defaultMaxQueuedPerClass = 100;
const defaultMinAvailableMemoryMb = 128;
const defaultMaxWorkerRssMb = 384;
const defaultMaxSwapUsedPercent = 95;
const defaultInitialToolMemoryMb = 384;
const defaultMinimumToolMemoryMb = 128;
const defaultMaximumToolMemoryMb = 4096;
const defaultSystemReserveMb = 128;
const defaultCoreReserveMb = 384;
const defaultToolHeapPercent = 65;
const defaultToolMemoryHighPercent = 85;
const defaultToolSwapMaxMb = 128;
const defaultMaxToolHeapMb = 4096;
const defaultMaxToolMemoryMb = 16_384;
const defaultMaxToolOutputBytes = 1_048_576;
const mebibyte = 1024 * 1024;

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
  if (execution != null && (!execution || typeof execution !== "object" || Array.isArray(execution))) {
    throw new Error("Tool execution policy must be an object");
  }
  const configured = execution || {};
  const resourceClass = resourceClassName(configured.resourceClass || "default");
  const weight = configured.weight == null ? 1 : positiveInteger(configured.weight, 0);
  if (!weight) throw new Error("Tool execution weight must be a positive integer");
  return {
    resourceClass,
    weight,
    deduplicateConcurrent: configured.deduplicateConcurrent === true,
    maxHeapMb: boundedInteger(configured.maxHeapMb, defaultMaxToolHeapMb, 64, 4096),
    maxMemoryMb: boundedInteger(configured.maxMemoryMb, defaultMaxToolMemoryMb, 128, 16_384),
    maxOutputBytes: boundedInteger(configured.maxOutputBytes, defaultMaxToolOutputBytes, 65_536, 16_777_216)
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
    minAvailableMemoryMb: boundedInteger(policy?.minAvailableMemoryMb, defaultMinAvailableMemoryMb, 0, 65_536),
    maxWorkerRssMb: boundedInteger(policy?.maxWorkerRssMb, defaultMaxWorkerRssMb, 64, 65_536),
    maxSwapUsedPercent: boundedInteger(policy?.maxSwapUsedPercent, defaultMaxSwapUsedPercent, 1, 100),
    initialToolMemoryMb: boundedInteger(policy?.initialToolMemoryMb, defaultInitialToolMemoryMb, 128, 16_384),
    minimumToolMemoryMb: boundedInteger(policy?.minimumToolMemoryMb, defaultMinimumToolMemoryMb, 64, 4096),
    maximumToolMemoryMb: boundedInteger(policy?.maximumToolMemoryMb, defaultMaximumToolMemoryMb, 128, 16_384),
    systemReserveMb: boundedInteger(policy?.systemReserveMb, defaultSystemReserveMb, 32, 65_536),
    coreReserveMb: boundedInteger(policy?.coreReserveMb, defaultCoreReserveMb, 64, 65_536),
    toolHeapPercent: boundedInteger(policy?.toolHeapPercent, defaultToolHeapPercent, 25, 90),
    toolMemoryHighPercent: boundedInteger(policy?.toolMemoryHighPercent, defaultToolMemoryHighPercent, 50, 95),
    toolSwapMaxMb: boundedInteger(policy?.toolSwapMaxMb, defaultToolSwapMaxMb, 0, 4096),
    capacities
  };
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
    this.memoryProfiles = new Map();
    this.activeMemoryMb = 0;
    this.lastMemoryBudgetMb = 0;
    this.peakRssBytes = 0;
    this.lastLoggedRssBytes = 0;
    this.lastPressure = null;
    this.draining = false;
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
    const logStepBytes = 8 * mebibyte;
    if (this.lastLoggedRssBytes && rss - this.lastLoggedRssBytes < logStepBytes) return;
    this.lastLoggedRssBytes = rss;
    this.logger?.log("tools", `worker RSS peak ${Math.ceil(rss / mebibyte)} MiB while using ${resourceClass}`);
  }

  memoryBudgetMb(snapshot) {
    const totalMb = Math.floor((Number(snapshot?.totalBytes) || 0) / mebibyte);
    const configuredMaximum = this.policy.maximumToolMemoryMb;
    if (!totalMb) return configuredMaximum;
    return Math.max(0, Math.min(
      configuredMaximum,
      totalMb - this.policy.systemReserveMb - this.policy.coreReserveMb
    ));
  }

  requestedMemoryMb(execution, label, budgetMb) {
    const learned = this.memoryProfiles.get(label)?.recommendedMemoryMb;
    const requested = learned || this.policy.initialToolMemoryMb;
    return Math.min(requested, execution.maxMemoryMb, this.policy.maximumToolMemoryMb, budgetMb);
  }

  heapLimitMb(execution, memoryLimitMb) {
    const proportional = Math.max(64, Math.floor(memoryLimitMb * this.policy.toolHeapPercent / 100));
    return Math.min(execution.maxHeapMb, proportional);
  }

  recordOutcome(label, memoryLimitMb, outcome = {}) {
    const current = this.memoryProfiles.get(label) || {
      recommendedMemoryMb: this.policy.initialToolMemoryMb,
      memoryLimitFailures: 0,
      successes: 0
    };
    if (outcome.memoryLimited) {
      current.memoryLimitFailures += 1;
      current.recommendedMemoryMb = Math.min(
        this.policy.maximumToolMemoryMb,
        Math.max(current.recommendedMemoryMb, memoryLimitMb + 128, Math.ceil(memoryLimitMb * 1.5))
      );
      this.logger?.log("tools", `${label} memory recommendation raised to ${current.recommendedMemoryMb} MiB after isolated limit failure`);
    } else if (outcome.success) {
      current.successes += 1;
    }
    this.memoryProfiles.set(label, current);
  }

  createLease(request, waitedMs) {
    let released = false;
    return {
      waitedMs,
      memoryLimitMb: request.memoryMb,
      heapLimitMb: this.heapLimitMb(request.execution, request.memoryMb),
      memoryHighPercent: this.policy.toolMemoryHighPercent,
      swapMaxMb: this.policy.toolSwapMaxMb,
      release: (outcome = {}) => {
        if (released) return;
        released = true;
        const state = this.stateFor(request.resourceClass);
        state.activeWeight = Math.max(0, state.activeWeight - request.weight);
        this.activeMemoryMb = Math.max(0, this.activeMemoryMb - request.memoryMb);
        this.recordOutcome(request.label, request.memoryMb, outcome);
        this.observeMemory(request.resourceClass);
        this.drainAll().catch((error) => {
          this.logger?.error("tools", `could not drain tool execution queues: ${error?.message || String(error)}`);
        });
      }
    };
  }

  grant(request) {
    const state = this.stateFor(request.resourceClass);
    state.activeWeight += request.weight;
    this.activeMemoryMb += request.memoryMb;
    const waitedMs = Math.max(0, this.now() - request.queuedAt);
    this.observeMemory(request.resourceClass);
    if (waitedMs > 0) {
      this.logger?.log("tools", `${request.label} acquired ${request.resourceClass} capacity and ${request.memoryMb} MiB after ${waitedMs}ms`);
    }
    request.resolve(this.createLease(request, waitedMs));
  }

  async pressureSnapshot(label, resourceClass) {
    const pressure = await this.memoryPressure();
    this.lastPressure = pressure;
    this.lastMemoryBudgetMb = this.memoryBudgetMb(pressure);
    const reason = memoryPressureReason(pressure, this.policy);
    if (!reason) return pressure;
    const error = new Error(`Tool ${label} was not started because ${reason}`);
    error.code = "TOOL_RESOURCE_PRESSURE";
    this.logger?.log("tools", `${label} rejected for ${resourceClass}: ${reason}`);
    throw error;
  }

  canGrant(request) {
    const state = this.stateFor(request.resourceClass);
    return state.activeWeight + request.weight <= this.capacityFor(request.resourceClass)
      && this.activeMemoryMb + request.memoryMb <= this.lastMemoryBudgetMb;
  }

  async drainAll() {
    if (this.draining) return;
    this.draining = true;
    try {
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const [resourceClass, state] of this.resources) {
          const next = state.queue[0];
          if (!next) continue;
          try {
            const pressure = await this.pressureSnapshot(next.label, resourceClass);
            const budgetMb = this.memoryBudgetMb(pressure);
            next.memoryMb = this.requestedMemoryMb(next.execution, next.label, budgetMb);
            if (next.memoryMb < this.policy.minimumToolMemoryMb || !this.canGrant(next)) continue;
            state.queue.shift();
            this.grant(next);
            progressed = true;
          } catch (error) {
            state.queue.shift();
            next.reject(error);
            progressed = true;
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async acquire(rawExecution, label = "tool") {
    const execution = normalizeToolExecution(rawExecution);
    const resourceClass = execution.resourceClass;
    const capacity = this.capacityFor(resourceClass);
    const weight = Math.min(execution.weight, capacity);
    const state = this.stateFor(resourceClass);
    const pressure = await this.pressureSnapshot(label, resourceClass);
    const budgetMb = this.memoryBudgetMb(pressure);
    const memoryMb = this.requestedMemoryMb(execution, label, budgetMb);
    if (budgetMb < this.policy.minimumToolMemoryMb || memoryMb < this.policy.minimumToolMemoryMb) {
      const error = new Error(`Tool ${label} was not started because the global tool memory pool is ${budgetMb} MiB`);
      error.code = "TOOL_RESOURCE_PRESSURE";
      throw error;
    }
    const request = {
      execution,
      resourceClass,
      weight,
      memoryMb,
      label,
      queuedAt: this.now()
    };
    if (!state.queue.length && this.canGrant(request)) {
      return new Promise((resolve) => this.grant({ ...request, resolve }));
    }
    if (state.queue.length >= this.policy.maxQueuedPerClass) {
      throw new Error(`Tool execution queue is full for resource class ${resourceClass}`);
    }
    this.logger?.log("tools", `${label} queued for ${resourceClass} capacity and global memory (${this.activeMemoryMb}/${budgetMb} MiB)`);
    return new Promise((resolve, reject) => {
      state.queue.push({ ...request, resolve, reject });
    });
  }

  snapshot() {
    return {
      peakRssBytes: this.peakRssBytes,
      memoryPressure: this.lastPressure,
      memory: {
        budgetMb: this.lastMemoryBudgetMb,
        activeMb: this.activeMemoryMb,
        profiles: Object.fromEntries([...this.memoryProfiles.entries()].map(([name, profile]) => [name, { ...profile }]))
      },
      resources: Object.fromEntries([...this.resources.entries()].map(([name, state]) => [name, {
        capacity: this.capacityFor(name),
        activeWeight: state.activeWeight,
        queued: state.queue.length
      }]))
    };
  }
}
