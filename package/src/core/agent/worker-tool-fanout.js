const defaults = Object.freeze({
  enabled: true,
  maxConcurrent: 2,
  pressureConcurrent: 1,
  serializePercent: 60
});

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.floor(number))) : fallback;
}

function boundedPercent(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(99, Math.max(1, number)) : fallback;
}

export function normalizeToolFanoutConfig(config = {}) {
  const maxConcurrent = boundedInteger(config.maxConcurrent, defaults.maxConcurrent, 1, 16);
  return {
    enabled: config.enabled !== false,
    maxConcurrent,
    pressureConcurrent: Math.min(
      maxConcurrent,
      boundedInteger(config.pressureConcurrent, defaults.pressureConcurrent, 1, 16)
    ),
    serializePercent: boundedPercent(config.serializePercent, defaults.serializePercent)
  };
}

export class WorkerToolFanoutController {
  constructor({ heapCircuitBreaker, logger, config = {} }) {
    this.heapCircuitBreaker = heapCircuitBreaker;
    this.logger = logger;
    this.active = 0;
    this.queue = [];
    this.draining = false;
    this.metrics = {
      peakActive: 0,
      peakQueued: 0,
      pressureSerializations: 0,
      rejectedAdmissions: 0,
      completed: 0
    };
    this.setConfig(config);
  }

  setConfig(config = {}) {
    this.config = normalizeToolFanoutConfig(config);
    this.drain();
  }

  capacity() {
    if (!this.config.enabled) return Number.POSITIVE_INFINITY;
    const pressure = this.heapCircuitBreaker.sample();
    if (pressure.percent >= this.config.serializePercent) {
      this.metrics.pressureSerializations += 1;
      return this.config.pressureConcurrent;
    }
    return this.config.maxConcurrent;
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && this.active < this.capacity()) {
        const job = this.queue.shift();
        try {
          await this.heapCircuitBreaker.admit();
        } catch (error) {
          this.metrics.rejectedAdmissions += 1;
          job.reject(error);
          continue;
        }
        this.active += 1;
        this.metrics.peakActive = Math.max(this.metrics.peakActive, this.active);
        job.resolve();
      }
    } finally {
      this.draining = false;
    }
  }

  acquire() {
    if (!this.config.enabled) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.metrics.peakQueued = Math.max(this.metrics.peakQueued, this.queue.length);
      this.drain();
    });
  }

  release() {
    if (this.config.enabled) this.active = Math.max(0, this.active - 1);
    this.metrics.completed += 1;
    this.drain();
  }

  async run(work) {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  getDiagnostic() {
    return {
      ...this.config,
      active: this.active,
      queued: this.queue.length,
      ...this.metrics
    };
  }
}
