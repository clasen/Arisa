export class SemanticWarmup {
  constructor({ initialize, listRecords, indexRecord, deleteRecord, clear, dispose }) {
    this.initialize = initialize;
    this.listRecords = listRecords;
    this.indexRecord = indexRecord;
    this.deleteRecord = deleteRecord;
    this.clear = clear;
    this.dispose = dispose;
    this.status = "warming";
    this.error = null;
    this.resources = null;
    this.pending = new Map();
    this.rebuildRequested = false;
    this.startedAt = new Date().toISOString();
    this.readyAt = null;
    this.promise = null;
    this.closed = false;
  }

  start() {
    if (!this.promise) this.promise = this.warm();
    return this;
  }

  async indexAll() {
    const records = await this.listRecords();
    for (const record of records) {
      if (this.closed) return;
      await this.indexRecord(this.resources, record.id, record);
    }
  }

  async flushPending() {
    while (!this.closed && (this.rebuildRequested || this.pending.size)) {
      if (this.rebuildRequested) {
        this.rebuildRequested = false;
        this.pending.clear();
        await this.clear(this.resources);
        await this.indexAll();
        continue;
      }
      const batch = [...this.pending.entries()];
      this.pending.clear();
      for (const [id, operation] of batch) {
        if (this.closed) return;
        if (operation.type === "delete") await this.deleteRecord(this.resources, id);
        else await this.indexRecord(this.resources, id, operation.record);
      }
    }
  }

  async warm() {
    try {
      const resources = await this.initialize();
      if (this.closed) {
        await this.dispose(resources);
        return;
      }
      this.resources = resources;
      await this.indexAll();
      await this.flushPending();
      if (this.closed) return;
      this.status = "ready";
      this.readyAt = new Date().toISOString();
    } catch (error) {
      if (this.closed) return;
      this.status = "degraded";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  async upsert(id, record) {
    if (this.status === "ready") {
      return { applied: await this.indexRecord(this.resources, id, record), deferred: false };
    }
    this.pending.set(id, { type: "upsert", record });
    return { applied: false, deferred: true };
  }

  async delete(id) {
    if (this.status === "ready") {
      return { applied: await this.deleteRecord(this.resources, id), deferred: false };
    }
    this.pending.set(id, { type: "delete" });
    return { applied: false, deferred: true };
  }

  async reindex() {
    if (this.status !== "ready") {
      this.rebuildRequested = true;
      return { deferred: true, indexed: 0 };
    }
    await this.clear(this.resources);
    const records = await this.listRecords();
    let indexed = 0;
    for (const record of records) {
      if (await this.indexRecord(this.resources, record.id, record)) indexed += 1;
    }
    return { deferred: false, indexed };
  }

  snapshot() {
    return {
      status: this.status,
      error: this.error,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      pending: this.pending.size,
      rebuildRequested: this.rebuildRequested
    };
  }

  async close() {
    this.closed = true;
    if (this.resources) await this.dispose(this.resources);
  }
}
