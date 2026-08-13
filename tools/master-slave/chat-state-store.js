import path from "node:path";
import { readSecureJson, writeSecureJson } from "./lib/secure-store.js";

export class ChatMasterSlaveStore {
  #operation = Promise.resolve();

  constructor(root) {
    if (!path.isAbsolute(root)) throw new Error("Chat Master/Slave state root must be absolute");
    this.groupsFile = path.join(root, "groups.json");
    this.batchesFile = path.join(root, "batches.json");
  }

  #serial(work) {
    const current = this.#operation.catch(() => {}).then(work);
    this.#operation = current;
    return current;
  }

  listGroups() {
    return readSecureJson(this.groupsFile, { version: 1, groups: [] }).then((stored) => stored.groups || []);
  }

  saveGroups(groups) {
    return this.#serial(async () => {
      await writeSecureJson(this.groupsFile, { version: 1, groups });
      return groups;
    });
  }

  listBatches() {
    return readSecureJson(this.batchesFile, { version: 1, batches: [] }).then((stored) => stored.batches || []);
  }

  saveBatch(batch) {
    return this.#serial(async () => {
      const batches = await this.listBatches();
      const next = batches.some((item) => item.batchId === batch.batchId)
        ? batches.map((item) => item.batchId === batch.batchId ? batch : item)
        : [...batches, batch];
      await writeSecureJson(this.batchesFile, { version: 1, batches: next.slice(-1_000) });
      return batch;
    });
  }
}
