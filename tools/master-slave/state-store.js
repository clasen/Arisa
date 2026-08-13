import path from "node:path";
import { readSecureJson, writeSecureJson } from "./lib/secure-store.js";

export class MasterSlaveStateStore {
  #operation = Promise.resolve();

  constructor(root) {
    if (!path.isAbsolute(root)) throw new Error("Master/Slave state root must be absolute");
    this.root = root;
    this.roleFile = path.join(root, "role.json");
    this.identityFile = path.join(root, "identity.json");
    this.peersFile = path.join(root, "peers.json");
    this.slaveFile = path.join(root, "slave.json");
    this.jobsFile = path.join(root, "jobs.json");
  }

  #serial(work) {
    const current = this.#operation.catch(() => {}).then(work);
    this.#operation = current;
    return current;
  }

  readRole() {
    return readSecureJson(this.roleFile, null);
  }

  writeRole(role) {
    if (!new Set(["master", "slave"]).has(role)) throw new Error("Role must be master or slave");
    return writeSecureJson(this.roleFile, { version: 1, role, updatedAt: new Date().toISOString() });
  }

  readSlave() {
    return readSecureJson(this.slaveFile, null);
  }

  writeSlave(value) {
    return writeSecureJson(this.slaveFile, { version: 1, ...value, updatedAt: new Date().toISOString() });
  }

  async unpairSlave() {
    const state = await this.readSlave();
    if (!state) return { unpaired: false };
    const { masterIdentityPublicKey, masterFingerprint, endpoint, secretId, ...retained } = state;
    await this.writeSlave({ ...retained, paired: false, revokedAt: new Date().toISOString() });
    return { unpaired: true };
  }

  listPeers() {
    return readSecureJson(this.peersFile, { version: 1, peers: [] }).then((stored) => stored.peers || []);
  }

  async getPeer(slaveId) {
    return (await this.listPeers()).find((peer) => peer.slaveId === slaveId) || null;
  }

  savePeer(peer) {
    return this.#serial(async () => {
      const peers = await this.listPeers();
      const index = peers.findIndex((item) => item.slaveId === peer.slaveId);
      const next = index === -1 ? [...peers, peer] : peers.map((item, itemIndex) => itemIndex === index ? { ...item, ...peer } : item);
      await writeSecureJson(this.peersFile, { version: 1, peers: next });
      return next.find((item) => item.slaveId === peer.slaveId);
    });
  }

  revokePeer(slaveId) {
    return this.#serial(async () => {
      const peers = await this.listPeers();
      const match = peers.find((peer) => peer.slaveId === slaveId);
      if (!match) return null;
      const revoked = { ...match, revoked: true, revokedAt: new Date().toISOString(), connectionState: "revoked" };
      await writeSecureJson(this.peersFile, {
        version: 1,
        peers: peers.map((peer) => peer.slaveId === slaveId ? revoked : peer)
      });
      return revoked;
    });
  }

  listJobs() {
    return readSecureJson(this.jobsFile, { version: 1, jobs: [] }).then((stored) => stored.jobs || []);
  }

  saveJob(job) {
    return this.#serial(async () => {
      const jobs = await this.listJobs();
      const existing = jobs.find((item) => item.jobId === job.jobId);
      if (existing?.status && ["completed", "failed", "cancelled", "expired"].includes(existing.status)) return existing;
      const next = existing
        ? jobs.map((item) => item.jobId === job.jobId ? { ...item, ...job } : item)
        : [...jobs, job];
      await writeSecureJson(this.jobsFile, { version: 1, jobs: next.slice(-10_000) });
      return next.find((item) => item.jobId === job.jobId);
    });
  }
}
