import v8 from "node:v8";

const defaults = Object.freeze({
  enabled: true,
  softPercent: 70,
  criticalPercent: 82,
  waitMs: 15_000,
  pollMs: 500
});

function boundedPercent(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(99, Math.max(1, number)) : fallback;
}

function boundedMilliseconds(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.floor(number))) : fallback;
}

function normalizeConfig(config = {}) {
  const softPercent = boundedPercent(config.softPercent, defaults.softPercent);
  return {
    enabled: config.enabled !== false,
    softPercent,
    criticalPercent: Math.max(softPercent + 1, boundedPercent(config.criticalPercent, defaults.criticalPercent)),
    waitMs: boundedMilliseconds(config.waitMs, defaults.waitMs, 0, 120_000),
    pollMs: boundedMilliseconds(config.pollMs, defaults.pollMs, 50, 5_000)
  };
}

export function readWorkerHeapPressure({ memoryUsage = process.memoryUsage, heapStatistics = v8.getHeapStatistics } = {}) {
  const heapUsed = Math.max(0, Number(memoryUsage().heapUsed) || 0);
  const heapLimit = Math.max(1, Number(heapStatistics().heap_size_limit) || 1);
  return {
    heapUsed,
    heapLimit,
    percent: heapUsed / heapLimit * 100
  };
}

export class WorkerHeapPressureError extends Error {
  constructor(pressure) {
    super(`Worker heap pressure remained critical at ${pressure.percent.toFixed(1)}%; retry this request shortly`);
    this.name = "WorkerHeapPressureError";
    this.code = "WORKER_HEAP_PRESSURE";
    this.retryable = true;
    this.pressure = pressure;
  }
}

export class WorkerHeapCircuitBreaker {
  constructor({ lifecycle, logger, config, measure = readWorkerHeapPressure, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }) {
    this.lifecycle = lifecycle;
    this.logger = logger;
    this.measure = measure;
    this.sleep = sleep;
    this.now = now;
    this.metrics = {
      pressureEvents: 0,
      evictedSessions: 0,
      delayedAdmissions: 0,
      rejectedAdmissions: 0,
      peakHeapPercent: 0
    };
    this.setConfig(config);
  }

  setConfig(config) {
    this.config = normalizeConfig(config);
  }

  sample() {
    const pressure = this.measure();
    this.metrics.peakHeapPercent = Math.max(this.metrics.peakHeapPercent, pressure.percent);
    return pressure;
  }

  async relievePressure() {
    const evicted = await this.lifecycle.evictInactive();
    this.metrics.evictedSessions += evicted.length;
    return evicted;
  }

  async admit() {
    let pressure = this.sample();
    if (!this.config.enabled || pressure.percent < this.config.softPercent) return pressure;

    this.metrics.pressureEvents += 1;
    const evicted = await this.relievePressure();
    pressure = this.sample();
    this.logger?.log("agent", `worker heap pressure ${pressure.percent.toFixed(1)}%; evicted ${evicted.length} inactive session(s)`);
    if (pressure.percent < this.config.criticalPercent) return pressure;

    this.metrics.delayedAdmissions += 1;
    const deadline = this.now() + this.config.waitMs;
    while (this.now() < deadline) {
      await this.sleep(Math.min(this.config.pollMs, Math.max(0, deadline - this.now())));
      await this.relievePressure();
      pressure = this.sample();
      if (pressure.percent < this.config.criticalPercent) {
        this.logger?.log("agent", `worker heap pressure recovered to ${pressure.percent.toFixed(1)}%`);
        return pressure;
      }
    }

    this.metrics.rejectedAdmissions += 1;
    this.logger?.log("agent", `worker heap admission rejected at ${pressure.percent.toFixed(1)}%`);
    throw new WorkerHeapPressureError(pressure);
  }

  getDiagnostic() {
    const pressure = this.sample();
    return {
      ...this.config,
      heapUsed: pressure.heapUsed,
      heapLimit: pressure.heapLimit,
      currentHeapPercent: pressure.percent,
      ...this.metrics
    };
  }
}
