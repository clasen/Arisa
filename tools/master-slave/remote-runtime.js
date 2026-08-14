import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseBootstrapUrl } from "./lib/bootstrap-url.js";
import { loadOrCreateIdentity, identityFingerprint } from "./lib/handshake-crypto.js";
import { addressesEqual } from "./lib/ip-address.js";
import { PairingSecretStore } from "./lib/pairing-secret-store.js";
import { buildSafeSlaveProfile, buildSafeToolCatalog } from "./lib/profile-catalog.js";
import { acceptMasterHandshake, connectSlaveHandshake, MESSAGE_TYPES } from "./network-session.js";
import { listSlavePath, readSlaveFile, SlaveProcessExecutor } from "./slave-operations.js";

const ROOT_DEFAULT_CAPABILITIES = Object.freeze(["inspect", "read", "tool.run", "tool.install", "exec"]);

export function resolveSlavePolicy({ policy = null, config, root = process.geteuid?.() === 0 } = {}) {
  if (!config || !Array.isArray(config.roots) || !Array.isArray(config.capabilities)) {
    throw new Error("Slave policy requires configured roots and capabilities");
  }
  if (policy) {
    if (!Array.isArray(policy.roots) || !Array.isArray(policy.capabilities)) {
      throw new Error("Stored Slave policy requires roots and capabilities");
    }
    return {
      roots: policy.roots,
      capabilities: policy.capabilities,
      fullHost: policy.fullHost === true
    };
  }
  if (root && config.roots.length === 0 && config.capabilities.length === 0) {
    return {
      roots: ["/"],
      capabilities: [...ROOT_DEFAULT_CAPABILITIES],
      fullHost: true
    };
  }
  return {
    roots: config.roots,
    capabilities: config.capabilities,
    fullHost: config.fullHost === true
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requirePositive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function requireMasterConfig(config) {
  if (!config.listenHost || !net.isIP(config.listenHost)) throw new Error("Master config requires an IP literal listenHost");
  requirePositive(config.listenPort, "listenPort");
  if (config.listenPort > 65_535) throw new Error("listenPort must be at most 65535");
  if (!config.publicEndpoint) throw new Error("Master config requires publicEndpoint");
  const probe = parseBootstrapUrl(`${config.publicEndpoint}/arisa_secret_v1_${Buffer.alloc(32).toString("base64url")}`);
  if (probe.endpoint !== config.publicEndpoint) throw new Error("publicEndpoint must be a canonical tcp://IP:port endpoint");
}

async function terminalForWire(terminal, onChunk, { maxFrameBytes }) {
  const wire = structuredClone(terminal);
  const rawChunkBytes = Math.max(1, Math.floor(maxFrameBytes / 2));
  let sequence = 1;
  const artifact = wire.result?.output?.remoteArtifact || wire.result?.remoteArtifact;
  if (artifact?.contentBase64 != null) {
    const content = Buffer.from(artifact.contentBase64, "base64");
    delete artifact.contentBase64;
    for (let offset = 0; offset < content.length; offset += rawChunkBytes) {
      await onChunk({
        sequence: sequence++,
        channel: "artifact",
        data: content.subarray(offset, offset + rawChunkBytes).toString("base64")
      });
    }
  }
  const text = wire.result?.output?.text;
  if (typeof text === "string" && Buffer.byteLength(text, "utf8") > rawChunkBytes) {
    const content = Buffer.from(text, "utf8");
    delete wire.result.output.text;
    wire.result.output.remoteText = { encoding: "utf8" };
    for (let offset = 0; offset < content.length; offset += rawChunkBytes) {
      await onChunk({
        sequence: sequence++,
        channel: "remote_text",
        data: content.subarray(offset, offset + rawChunkBytes).toString("base64")
      });
    }
  }
  return wire;
}

function writeSocketClose(server) {
  return new Promise((resolve) => server.close(resolve));
}

function createPendingConnection(connection, { maxJobOutputBytes }) {
  const pending = new Map();
  connection.on("message", (message) => {
    if (message.type === MESSAGE_TYPES.HEARTBEAT) {
      connection.send(MESSAGE_TYPES.HEARTBEAT, { acknowledgedAt: new Date().toISOString() }).catch(() => {});
      return;
    }
    const jobId = message.payload?.jobId;
    const request = jobId ? pending.get(jobId) : null;
    if (!request) return;
    if (message.type !== MESSAGE_TYPES.JOB_EVENT) return;
    const event = message.payload;
    if (event.status === "chunk" && ["artifact", "remote_text"].includes(event.chunk?.channel)) {
      const chunk = Buffer.from(String(event.chunk.data || ""), "base64");
      request.artifactBytes += chunk.length;
      if (request.artifactBytes > maxJobOutputBytes) {
        pending.delete(jobId);
        const error = Object.assign(new Error("Remote artifact exceeds the job output limit"), { code: "OUTPUT_LIMIT_EXCEEDED" });
        request.reject(error);
        connection.close();
        return;
      }
      request.contentChunks[event.chunk.channel].push(chunk);
      return;
    }
    request.onEvent?.(event);
    if (!["completed", "failed", "cancelled", "expired"].includes(event.status)) return;
    pending.delete(jobId);
    if (event.status === "completed") {
      const artifact = event.result?.output?.remoteArtifact || event.result?.remoteArtifact;
      if (artifact) artifact.contentBase64 = Buffer.concat(request.contentChunks.artifact).toString("base64");
      const remoteText = event.result?.output?.remoteText;
      if (remoteText) {
        event.result.output.text = Buffer.concat(request.contentChunks.remote_text).toString("utf8");
        delete event.result.output.remoteText;
      }
      request.resolve(event.result);
    }
    else {
      const error = new Error(event.error?.message || `Remote job ${event.status}`);
      error.code = event.error?.code || event.status.toUpperCase();
      request.reject(error);
    }
  });
  connection.on("protocolError", (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  connection.start();
  return {
    async run(job, { onEvent } = {}) {
      if (pending.has(job.jobId)) throw new Error(`Remote job is already active: ${job.jobId}`);
      const result = new Promise((resolve, reject) => pending.set(job.jobId, {
        resolve,
        reject,
        onEvent,
        artifactBytes: 0,
        contentChunks: { artifact: [], remote_text: [] }
      }));
      try {
        await connection.send(MESSAGE_TYPES.JOB_REQUEST, job);
      } catch (error) {
        pending.delete(job.jobId);
        throw error;
      }
      return result;
    },
    async cancel(jobId) {
      await connection.send(MESSAGE_TYPES.JOB_CANCEL, { jobId });
    },
    async revoke() {
      await connection.send(MESSAGE_TYPES.REVOKE, { revokedAt: new Date().toISOString() });
    },
    close: () => connection.close()
  };
}

export async function notifySlavePairing({ type, peer, paired }, clientForChat) {
  if (type !== "connected" || paired !== true) return false;
  const name = peer.profile?.name || peer.slaveId;
  for (const chatId of peer.authorizedChatIds || []) {
    await clientForChat(chatId).agent.enqueueEvent({
      resourceId: peer.slaveId,
      prompt: `Arisa Slave ${name} (${peer.slaveId}) finished pairing and is connected. Notify the user now with a concise confirmation that the Slave was added successfully and is online.`
    }).catch(() => {});
  }
  return true;
}

export class MasterNetworkRuntime {
  constructor({ config, state, identity, pairingStore, onConnectionEvent } = {}) {
    requireMasterConfig(config);
    this.config = config;
    this.state = state;
    this.identity = identity;
    this.pairingStore = pairingStore;
    this.onConnectionEvent = onConnectionEvent;
    this.connections = new Map();
    this.server = null;
  }

  async start() {
    if (this.server) return;
    this.server = net.createServer((socket) => {
      acceptMasterHandshake(socket, {
        identity: this.identity,
        pairing: this.pairingStore,
        resolvePeer: (slaveId) => this.state.getPeer(slaveId),
        persistPeer: (peer) => this.state.savePeer({
          ...peer,
          connectionState: "connected",
          disconnectedAt: null,
          offlineNoticeAt: null
        }),
        maxFrameBytes: this.config.maxFrameBytes
      }).then(async ({ connection, peer, paired }) => {
        const existing = this.connections.get(peer.slaveId);
        existing?.close();
        const remote = createPendingConnection(connection, { maxJobOutputBytes: this.config.maxJobOutputBytes });
        this.connections.set(peer.slaveId, remote);
        await this.onConnectionEvent?.({ type: "connected", peer, paired });
        socket.once("close", async () => {
          if (this.connections.get(peer.slaveId) !== remote) return;
          this.connections.delete(peer.slaveId);
          const disconnectedAt = new Date().toISOString();
          await this.state.savePeer({ ...peer, connectionState: "offline", disconnectedAt });
          await this.onConnectionEvent?.({ type: "disconnected", peer: { ...peer, disconnectedAt } });
        });
      }).catch(() => socket.destroy());
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.listenPort, this.config.listenHost, resolve);
    });
  }

  async stop() {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    if (this.server) {
      const closing = writeSocketClose(this.server);
      this.server.closeAllConnections?.();
      await closing;
    }
    this.server = null;
  }

  async createBootstrap(chatId) {
    const pending = await this.pairingStore.create({ chatId, endpoint: this.config.publicEndpoint });
    return {
      endpoint: this.config.publicEndpoint,
      expiresAt: pending.expiresAt,
      secretId: pending.secretId,
      url: `${this.config.publicEndpoint}/${pending.secret}`
    };
  }

  connection(slaveId) {
    const connection = this.connections.get(slaveId);
    if (!connection) {
      const error = new Error(`Slave is offline: ${slaveId}`);
      error.code = "SLAVE_OFFLINE";
      throw error;
    }
    return connection;
  }

  run(job, options) {
    return this.connection(job.slaveId).run(job, options);
  }

  async cancel(slaveId, jobId) {
    return this.connection(slaveId).cancel(jobId);
  }

  async revoke(slaveId) {
    const connection = this.connections.get(slaveId);
    if (connection) {
      await connection.revoke().catch(() => {});
      connection.close();
      this.connections.delete(slaveId);
    }
    return this.state.revokePeer(slaveId);
  }
}

async function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export async function bootstrapSlaveConnection({ url, state, identity, profile, maxFrameBytes }) {
  const bootstrap = parseBootstrapUrl(url);
  const existing = await state.readSlave();
  const socket = await connectTcp(bootstrap.host, bootstrap.port);
  try {
    if (!addressesEqual(socket.remoteAddress, bootstrap.host)) {
      throw new Error("Connected Master address does not match the bootstrap IP literal");
    }
    const connected = await connectSlaveHandshake(socket, {
      identity,
      slaveId: existing?.slaveId || crypto.randomUUID(),
      profile,
      secret: bootstrap.secret,
      secretId: crypto.createHash("sha256").update(bootstrap.secret).digest().subarray(0, 12).toString("base64url"),
      expectedMasterPublicKey: existing?.masterIdentityPublicKey || null,
      maxFrameBytes
    });
    const slaveId = connected.acknowledgement.slaveId;
    await state.writeRole("slave");
    await state.writeSlave({
      slaveId,
      paired: true,
      endpoint: bootstrap.endpoint,
      masterIdentityPublicKey: connected.master.identityPublicKey,
      masterFingerprint: connected.master.fingerprint,
      authorizedChatIds: connected.acknowledgement.authorizedChatIds,
      pairedAt: new Date().toISOString()
    });
    return { connection: connected.connection, slaveId, endpoint: bootstrap.endpoint };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function loadProfile({ state, arisa, config, arisaVersion }) {
  const slave = await state.readSlave();
  const policy = resolveSlavePolicy({
    policy: slave?.policy,
    config,
    root: process.geteuid?.() === 0
  });
  const client = typeof arisa === "function" ? arisa(null) : arisa;
  const tools = buildSafeToolCatalog((await client.tools.list()).slice(0, config.maxCatalogTools));
  return buildSafeSlaveProfile({
    slaveId: slave?.slaveId || "",
    name: policy.name || config.name || os.hostname(),
    description: policy.description || config.description || "",
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    arisaVersion,
    masterEndpoint: slave?.endpoint || "",
    privilege: {
      user: os.userInfo().username,
      root: process.geteuid?.() === 0,
      scope: policy.fullHost ? "full-host" : "restricted"
    },
    roots: policy.roots,
    capabilities: policy.capabilities
  }, { tools });
}

export class SlaveNetworkRuntime {
  constructor({ config, state, identity, arisa, arisaVersion, onConnectionEvent } = {}) {
    this.config = config;
    this.state = state;
    this.identity = identity;
    this.arisa = arisa;
    this.arisaVersion = arisaVersion;
    this.onConnectionEvent = onConnectionEvent;
    this.running = false;
    this.connection = null;
    this.processes = new SlaveProcessExecutor({
      roots: config.roots,
      maxOutputBytes: config.maxJobOutputBytes,
      maxTimeoutMs: config.maxProcessTimeoutMs
    });
  }

  async #profile() {
    return loadProfile(this);
  }

  async #execute(job, onChunk) {
    const existing = await this.state.listJobs().then((jobs) => jobs.find((item) => item.jobId === job.jobId));
    if (existing?.terminalResult) return terminalForWire(existing.terminalResult, onChunk, this.config);
    if (existing?.status === "accepted") {
      const interrupted = {
        jobId: job.jobId,
        status: "failed",
        error: {
          message: "Remote job was interrupted after acceptance; it was not repeated",
          code: "JOB_INTERRUPTED"
        }
      };
      await this.state.saveJob({ ...existing, status: "failed", terminalResult: interrupted, finishedAt: new Date().toISOString() });
      return interrupted;
    }
    const slaveState = await this.state.readSlave();
    if (!slaveState?.authorizedChatIds?.some((chatId) => String(chatId) === String(job.requestedByChatId))) {
      throw Object.assign(new Error("Remote job chat is not authorized for this Slave"), { code: "NOT_AUTHORIZED" });
    }
    if (Date.parse(job.expiresAt) <= Date.now()) return { status: "expired", error: { message: "Remote job expired" } };
    const policy = resolveSlavePolicy({
      policy: slaveState?.policy,
      config: this.config,
      root: process.geteuid?.() === 0
    });
    const jobArisa = () => typeof this.arisa === "function" ? this.arisa(job.requestedByChatId) : this.arisa;
    const requiredCapability = {
      "slave.inspect": "inspect",
      "fs.list": "inspect",
      "fs.read": "read",
      "tool.list": "tool.run",
      "tool.run": "tool.run",
      "tool.install": "tool.install",
      "process.exec": "exec"
    }[job.operation];
    if (requiredCapability && !policy.capabilities.includes(requiredCapability)) {
      throw Object.assign(new Error(`Slave policy does not grant ${requiredCapability}`), { code: "CAPABILITY_MISSING" });
    }
    await this.state.saveJob({ ...job, status: "accepted", acceptedAt: new Date().toISOString() });
    let result;
    if (job.operation === "slave.configure") {
      const allowed = new Set(["inspect", "read", "tool.run", "tool.install", "exec"]);
      const capabilities = [...new Set(job.args.capabilities || [])];
      if (capabilities.some((capability) => !allowed.has(capability))) throw new Error("Slave policy contains an unsupported capability");
      const roots = [...new Set(job.args.roots || [])];
      if (roots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) throw new Error("Slave policy roots must be absolute paths");
      const rootProcess = process.geteuid?.() === 0;
      if (rootProcess && job.args.fullHost === true && job.args.confirmRoot !== slaveState.slaveId) {
        throw new Error("Full-host root policy requires confirmRoot equal to the Slave id");
      }
      const nextPolicy = {
        name: String(job.args.name || "").trim(),
        description: String(job.args.description || "").trim(),
        roots,
        capabilities,
        fullHost: job.args.fullHost === true
      };
      await this.state.writeSlave({ ...slaveState, policy: nextPolicy });
      result = { status: "completed", result: nextPolicy };
    } else if (job.operation === "slave.inspect") result = { status: "completed", result: await this.#profile() };
    else if (job.operation === "fs.list") result = { status: "completed", result: await listSlavePath({ target: job.args.path, roots: policy.roots, maxEntries: this.config.maxDirectoryEntries }) };
    else if (job.operation === "fs.read") {
      const read = await readSlaveFile({ target: job.args.path, roots: policy.roots, maxBytes: this.config.maxReadBytes });
      result = {
        status: "completed",
        result: {
          path: read.path,
          bytes: read.bytes,
          remoteArtifact: {
            fileName: path.basename(read.path),
            mimeType: "application/octet-stream",
            kind: "file",
            contentBase64: read.content.toString("base64")
          }
        }
      };
    } else if (job.operation === "tool.list") result = { status: "completed", result: buildSafeToolCatalog(await jobArisa().tools.list()) };
    else if (job.operation === "tool.install") {
      const tool = String(job.args.tool || "");
      if (!tool || job.args.confirmToolName !== tool) {
        throw new Error("Remote tool installation requires exact tool-name confirmation");
      }
      if (process.geteuid?.() === 0 && job.args.confirmRoot !== slaveState.slaveId) {
        throw new Error("Remote tool installation as root requires confirmRoot equal to the Slave id");
      }
      result = {
        status: "completed",
        result: await jobArisa().tools.installOfficial({ name: tool, confirmName: tool }, { timeoutMs: this.config.maxProcessTimeoutMs })
      };
    }
    else if (job.operation === "tool.run") {
      const arisa = jobArisa();
      const toolResult = await arisa.tools.run({ name: job.args.tool, args: job.args.args || {} }, { timeoutMs: job.args.timeoutMs });
      if (typeof toolResult?.output?.text === "string") {
        const text = Buffer.from(toolResult.output.text, "utf8");
        if (text.length > this.config.maxJobOutputBytes) {
          throw Object.assign(new Error("Remote tool text exceeds the job output limit"), { code: "OUTPUT_LIMIT_EXCEEDED" });
        }
      }
      const artifact = toolResult?.output?.artifactId
        ? await arisa.artifacts.get({ artifactId: toolResult.output.artifactId })
        : null;
      const artifactPath = artifact?.path || toolResult?.output?.filePath;
      if (artifactPath) {
        const file = await readFile(artifactPath);
        if (file.length > this.config.maxJobOutputBytes) {
          throw Object.assign(new Error("Remote tool artifact exceeds the job output limit"), { code: "OUTPUT_LIMIT_EXCEEDED" });
        }
        toolResult.output.remoteArtifact = {
          fileName: toolResult.output.fileName || artifact?.name || path.basename(artifactPath),
          mimeType: toolResult.output.mimeType || "application/octet-stream",
          kind: toolResult.output.kind || "file",
          delivery: toolResult.output.delivery || null,
          contentBase64: file.toString("base64")
        };
        delete toolResult.output.filePath;
        delete toolResult.output.artifactId;
      }
      result = toolResult?.ok === false
        ? { status: "failed", error: { message: toolResult.error || "Remote tool failed", code: toolResult.status || "TOOL_FAILED" } }
        : { status: "completed", result: toolResult };
    } else if (job.operation === "process.exec") {
      this.processes.roots = policy.roots;
      const executed = await this.processes.execute({ jobId: job.jobId, ...job.args }, { onChunk });
      const { chunks, ...summary } = executed;
      result = { status: executed.status, result: summary };
    } else throw Object.assign(new Error(`Unsupported Slave operation: ${job.operation}`), { code: "CAPABILITY_MISSING" });
    const terminal = { ...result, jobId: job.jobId };
    await this.state.saveJob({ ...job, status: result.status, terminalResult: terminal, finishedAt: new Date().toISOString() });
    return terminalForWire(terminal, onChunk, this.config);
  }

  #attach(connection) {
    connection.on("message", (message) => {
      if (message.type === MESSAGE_TYPES.REVOKE) {
        this.state.unpairSlave().finally(() => {
          this.running = false;
          connection.close();
        });
        return;
      }
      if (message.type === MESSAGE_TYPES.JOB_CANCEL) {
        this.processes.cancel(message.payload.jobId);
        return;
      }
      if (message.type !== MESSAGE_TYPES.JOB_REQUEST) return;
      const job = message.payload;
      this.#execute(job, (chunk) => connection.send(MESSAGE_TYPES.JOB_EVENT, {
        jobId: job.jobId,
        status: "chunk",
        chunk
      })).then((terminal) => connection.send(MESSAGE_TYPES.JOB_EVENT, terminal))
        .catch((error) => connection.send(MESSAGE_TYPES.JOB_EVENT, {
          jobId: job.jobId,
          status: "failed",
          error: { message: error?.message || String(error), code: error?.code || null }
        })).catch(() => {});
    });
    connection.start();
  }

  async start() {
    this.running = true;
    let attempt = 0;
    while (this.running) {
      const slave = await this.state.readSlave();
      if (!slave?.paired || !slave.endpoint || !slave.masterIdentityPublicKey) return;
      try {
        const probe = parseBootstrapUrl(`${slave.endpoint}/arisa_secret_v1_${Buffer.alloc(32).toString("base64url")}`);
        const socket = await connectTcp(probe.host, probe.port);
        if (!addressesEqual(socket.remoteAddress, probe.host)) throw new Error("Connected Master address does not match configured endpoint");
        const connected = await connectSlaveHandshake(socket, {
          identity: this.identity,
          slaveId: slave.slaveId,
          profile: await this.#profile(),
          expectedMasterPublicKey: slave.masterIdentityPublicKey,
          maxFrameBytes: this.config.maxFrameBytes
        });
        this.connection = connected.connection;
        this.#attach(this.connection);
        attempt = 0;
        await this.onConnectionEvent?.({ type: "connected" });
        await new Promise((resolve) => socket.once("close", resolve));
      } catch (error) {
        await this.onConnectionEvent?.({ type: "disconnected", error });
      } finally {
        this.connection = null;
      }
      if (!this.running) return;
      attempt += 1;
      const base = Math.min(this.config.reconnectMaxMs, this.config.reconnectMinMs * (2 ** Math.min(attempt - 1, 16)));
      await sleep(Math.floor(base * (0.5 + Math.random() * 0.5)));
    }
  }

  stop() {
    this.running = false;
    this.connection?.close();
    this.connection = null;
  }
}

export async function createRuntimeIdentity(state) {
  return loadOrCreateIdentity(state.identityFile);
}

export function createPairingStore(state, config) {
  return new PairingSecretStore({ file: path.join(state.root, "pairing-secrets.json"), ttlMs: config.bootstrapSecretTtlMs });
}

export function runtimeIdentityDiagnostic(identity) {
  return identityFingerprint(identity);
}
