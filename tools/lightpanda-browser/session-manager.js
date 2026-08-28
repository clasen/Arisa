import crypto from "node:crypto";

function sessionId() {
  return `lp_${crypto.randomBytes(18).toString("base64url")}`;
}

export class BrowserSessionManager {
  constructor({ createClient, ttlMs = 300_000, maxSessions = 3, now = Date.now, sweepIntervalMs = 1_000 }) {
    if (typeof createClient !== "function") throw new Error("createClient is required");
    this.createClient = createClient;
    this.ttlMs = Math.max(5_000, Number(ttlMs) || 300_000);
    this.maxSessions = Math.max(1, Math.min(10, Number(maxSessions) || 3));
    this.now = now;
    this.sweepIntervalMs = Math.max(100, Number(sweepIntervalMs) || 1_000);
    this.sessions = new Map();
    this.sweeper = null;
  }

  start() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.reapExpired().catch(() => {}), this.sweepIntervalMs);
    this.sweeper.unref?.();
  }

  async open() {
    await this.reapExpired();
    if (this.sessions.size >= this.maxSessions) throw new Error(`Lightpanda session limit reached (${this.maxSessions}). Close or wait for an existing session to expire.`);
    const id = sessionId();
    const client = await this.createClient();
    const timestamp = this.now();
    this.sessions.set(id, { id, client, createdAt: timestamp, lastUsedAt: timestamp, busy: false });
    return this.describe(this.sessions.get(id));
  }

  describe(session) {
    return {
      id: session.id,
      createdAt: new Date(session.createdAt).toISOString(),
      lastUsedAt: new Date(session.lastUsedAt).toISOString(),
      expiresAt: new Date(session.lastUsedAt + this.ttlMs).toISOString(),
      busy: session.busy
    };
  }

  list() {
    return [...this.sessions.values()].map((session) => this.describe(session));
  }

  has(id) {
    return this.sessions.has(String(id || ""));
  }

  get(id) {
    const session = this.sessions.get(String(id || ""));
    if (!session) throw Object.assign(new Error(`Unknown or expired Lightpanda session: ${id}`), { code: "LIGHTPANDA_SESSION_NOT_FOUND" });
    return session;
  }

  async executeWith(id, invoke, { signal } = {}) {
    const session = this.get(id);
    if (session.busy) throw new Error(`Lightpanda session is busy: ${id}`);
    session.busy = true;
    session.lastUsedAt = this.now();
    let abortListener;
    const aborted = new Promise((_, reject) => {
      abortListener = () => {
        const error = Object.assign(new Error(`Lightpanda session operation cancelled: ${id}`), { code: "DAEMON_JOB_CANCELLED" });
        this.close(id, "cancelled").finally(() => reject(error));
      };
      signal?.addEventListener("abort", abortListener, { once: true });
    });
    try {
      if (signal?.aborted) {
        await this.close(id, "cancelled");
        throw Object.assign(new Error(`Lightpanda session operation cancelled: ${id}`), { code: "DAEMON_JOB_CANCELLED" });
      }
      const call = Promise.resolve().then(() => invoke(session.client));
      const output = signal ? await Promise.race([call, aborted]) : await call;
      if (this.sessions.has(id)) {
        session.lastUsedAt = this.now();
        session.busy = false;
      }
      return output;
    } catch (error) {
      await this.close(id, error?.code === "DAEMON_JOB_CANCELLED" ? "cancelled" : "crashed");
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortListener);
    }
  }

  async execute(id, operation, args = {}, options = {}) {
    return this.executeWith(id, (client) => client.call(operation, args), options);
  }

  async executeResult(id, operation, args = {}, options = {}) {
    return this.executeWith(id, (client) => client.callResult(operation, args), options);
  }

  async close(id, reason = "explicit") {
    const session = this.sessions.get(String(id || ""));
    if (!session) return { id: String(id || ""), closed: false, reason: "not-found" };
    this.sessions.delete(session.id);
    await Promise.resolve(session.client.close?.()).catch(() => {});
    return { id: session.id, closed: true, reason };
  }

  async reapExpired() {
    const cutoff = this.now() - this.ttlMs;
    const expired = [...this.sessions.values()].filter((session) => !session.busy && session.lastUsedAt <= cutoff);
    return Promise.all(expired.map((session) => this.close(session.id, "expired")));
  }

  async closeAll(reason = "shutdown") {
    clearInterval(this.sweeper);
    this.sweeper = null;
    return Promise.all([...this.sessions.keys()].map((id) => this.close(id, reason)));
  }
}
