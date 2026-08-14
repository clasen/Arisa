import { summarizeBatch } from "./master-domain.js";

function positiveConcurrency(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("batch concurrency must be a positive integer");
  return value;
}

function terminalBatchStatus(summary) {
  if (summary.failed || summary.expired) return "failed";
  if (summary.cancelled || summary.notStarted) return "cancelled";
  return "completed";
}

function processOutput(chunks, channel) {
  return chunks
    .filter((chunk) => chunk?.channel === channel)
    .sort((left, right) => left.sequence - right.sequence)
    .map((chunk) => String(chunk.data || ""))
    .join("");
}

export class SlaveBatchRunner {
  constructor({ concurrency, persistBatch, executeJob, onEvent } = {}) {
    this.concurrency = positiveConcurrency(concurrency);
    if (typeof persistBatch !== "function") throw new Error("persistBatch is required");
    if (typeof executeJob !== "function") throw new Error("executeJob is required");
    this.persistBatch = persistBatch;
    this.executeJob = executeJob;
    this.onEvent = onEvent;
    this.active = new Map();
  }

  async run(batch) {
    if (this.active.has(batch.batchId)) throw new Error(`Batch is already active: ${batch.batchId}`);
    const state = { batch: structuredClone(batch), cancelRequested: false, controllers: new Map() };
    this.active.set(batch.batchId, state);
    await this.persistBatch(state.batch);

    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= state.batch.jobs.length) return;
        const job = state.batch.jobs[index];
        if (state.cancelRequested) {
          job.status = "not_started";
          job.finishedAt = new Date().toISOString();
          await this.persistBatch(state.batch);
          continue;
        }
        const controller = new AbortController();
        state.controllers.set(job.jobId, controller);
        job.status = "accepted";
        job.acceptedAt = new Date().toISOString();
        await this.persistBatch(state.batch);
        const processChunks = [];
        try {
          const result = await this.executeJob(job, {
            signal: controller.signal,
            onChunk: async (chunk) => {
              if (["stdout", "stderr"].includes(chunk?.channel)) processChunks.push(chunk);
              await this.onEvent?.({
                type: "chunk",
                batchId: state.batch.batchId,
                jobId: job.jobId,
                slaveId: job.slaveId,
                slaveName: job.slaveName || job.slaveId,
                sequence: chunk.sequence,
                payload: chunk
              });
            }
          });
          job.status = result.status || "completed";
          job.result = job.operation === "process.exec" ? {
            ...result,
            stdout: processOutput(processChunks, "stdout"),
            stderr: processOutput(processChunks, "stderr")
          } : result;
        } catch (error) {
          job.status = controller.signal.aborted ? "cancelled" : "failed";
          job.error = { message: error?.message || String(error), code: error?.code || null };
        } finally {
          state.controllers.delete(job.jobId);
          job.finishedAt = new Date().toISOString();
          await this.persistBatch(state.batch);
        }
      }
    };

    try {
      await Promise.all(Array.from(
        { length: Math.min(this.concurrency, state.batch.jobs.length) },
        () => worker()
      ));
      const summary = summarizeBatch(state.batch);
      state.batch.status = terminalBatchStatus(summary);
      state.batch.finishedAt = new Date().toISOString();
      state.batch.summary = summary;
      await this.persistBatch(state.batch);
      return state.batch;
    } finally {
      this.active.delete(batch.batchId);
    }
  }

  cancel(batchId) {
    const state = this.active.get(batchId);
    if (!state) return false;
    state.cancelRequested = true;
    for (const controller of state.controllers.values()) controller.abort();
    return true;
  }
}
