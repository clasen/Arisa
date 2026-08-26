import { readFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getChatPiSessionsDir, sessionStartOperationalNotesFile } from "../../platform/paths.js";
import { arisaInstallDir } from "./runtime-context.js";

const operationalNoteMaxChars = 220;

function normalizeOperationalNote(note) {
  const text = typeof note === "string" ? note : note?.text;
  const trimmed = String(text || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return trimmed.length <= operationalNoteMaxChars
    ? trimmed
    : `${trimmed.slice(0, operationalNoteMaxChars - 1).trim()}…`;
}

export function loadSessionStartOperationalNotes() {
  try {
    const raw = readFileSync(sessionStartOperationalNotesFile, "utf8");
    const parsed = JSON.parse(raw);
    const notes = Array.isArray(parsed) ? parsed : parsed?.notes;
    if (!Array.isArray(notes)) return [];
    return notes.map(normalizeOperationalNote).filter(Boolean).slice(0, 20);
  } catch {
    return [];
  }
}

function formatSessionStartOperationalNotes(notes) {
  if (!notes.length) return "";
  return [
    "Durable operating notes for this Arisa session:",
    ...notes.map((note) => `- ${note}`)
  ].join("\n");
}

function closeAgentSession(session) {
  if (session?.close) return session.close();
  if (session?.dispose) return session.dispose();
  return undefined;
}

export class AgentSessionLifecycle {
  constructor({ logger, summarizeContext, cachePolicy = {} }) {
    this.logger = logger;
    this.summarizeContext = summarizeContext;
    this.sessions = new Map();
    this.pendingNewSessions = new Set();
    this.pendingSessionHandoffs = new Map();
    this.sessionClosePromises = new Map();
    this.setCachePolicy(cachePolicy);
  }

  setCachePolicy(cachePolicy = {}) {
    this.cachePolicy = {
      maxSessions: Math.max(1, Number(cachePolicy.maxSessions) || 3),
      maxPersistedBytes: Math.max(1, Number(cachePolicy.maxPersistedBytes) || 48 * 1024 * 1024)
    };
  }

  acquireCached(sessionKey, persistedBytes = 0) {
    const context = this.sessions.get(String(sessionKey));
    if (!context) return;
    context.activeUsers = (context.activeUsers || 0) + 1;
    context.lastAccessedAt = Date.now();
    context.persistedBytes = Math.max(0, Number(persistedBytes) || 0);
  }

  releaseCached(sessionKey, persistedBytes = 0) {
    const context = this.sessions.get(String(sessionKey));
    if (!context) return;
    context.activeUsers = Math.max(0, (context.activeUsers || 0) - 1);
    context.lastAccessedAt = Date.now();
    context.persistedBytes = Math.max(0, Number(persistedBytes) || 0);
  }

  cacheUsage() {
    return {
      sessions: this.sessions.size,
      persistedBytes: [...this.sessions.values()].reduce((total, context) => total + (context.persistedBytes || 0), 0)
    };
  }

  cacheOverLimit() {
    const usage = this.cacheUsage();
    return usage.sessions > this.cachePolicy.maxSessions
      || usage.persistedBytes > this.cachePolicy.maxPersistedBytes;
  }

  evictionCandidate(protectedKeys = new Set()) {
    return [...this.sessions.entries()]
      .filter(([key, context]) => !protectedKeys.has(key) && !(context.activeUsers > 0) && !context.session?.isStreaming)
      .sort((left, right) => (left[1].lastAccessedAt || 0) - (right[1].lastAccessedAt || 0))[0];
  }

  async enforceCachePolicy({ protectedSessionKeys = [] } = {}) {
    const protectedKeys = new Set(protectedSessionKeys.map(String));
    const evicted = [];
    while (this.cacheOverLimit()) {
      const candidate = this.evictionCandidate(protectedKeys);
      if (!candidate) break;
      const [sessionKey, context] = candidate;
      evicted.push({ sessionKey, persistedBytes: context.persistedBytes || 0 });
      this.logger?.log("agent", `evicting inactive Pi session for chat ${sessionKey} from resident cache`);
      await this.closeCached(sessionKey);
    }
    return evicted;
  }

  closeCached(sessionKey) {
    const key = String(sessionKey);
    const existing = this.sessions.get(key);
    this.sessions.delete(key);
    const closeSession = (existing?.session?.close || existing?.session?.dispose)
      ? () => closeAgentSession(existing.session)
      : null;
    if (!closeSession) return this.sessionClosePromises.get(key) || Promise.resolve();

    const previousClose = this.sessionClosePromises.get(key);
    const closePromise = Promise.resolve(previousClose)
      .catch(() => {})
      .then(closeSession)
      .catch((error) => {
        this.logger?.error?.("agent", `session close failed for chat ${key}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.sessionClosePromises.get(key) === closePromise) {
          this.sessionClosePromises.delete(key);
        }
      });
    this.sessionClosePromises.set(key, closePromise);
    return closePromise;
  }

  async waitForClose(sessionKey) {
    const key = String(sessionKey);
    let closing = this.sessionClosePromises.get(key);
    while (closing) {
      await closing;
      closing = this.sessionClosePromises.get(key);
    }
  }

  resetConfigState() {
    for (const key of this.sessions.keys()) this.closeCached(key);
    this.pendingNewSessions.clear();
    this.pendingSessionHandoffs.clear();
  }

  resetSession(chatId, { handoff = "", parentSession = "" } = {}) {
    const sessionKey = String(chatId);
    this.closeCached(sessionKey);
    this.pendingNewSessions.add(sessionKey);
    const text = String(handoff || "").trim();
    const parent = String(parentSession || "").trim();
    if (text || parent) {
      this.pendingSessionHandoffs.set(sessionKey, { text, parentSession: parent });
    } else {
      this.pendingSessionHandoffs.delete(sessionKey);
    }
  }

  createSessionManager(chatId, workspaceDir = arisaInstallDir, sessionRevision = 0) {
    const sessionKey = String(chatId);
    const sessionDir = getChatPiSessionsDir(sessionKey, sessionRevision);
    if (this.pendingNewSessions.has(sessionKey)) {
      this.logger?.log("agent", `starting new persisted session for chat ${sessionKey}`);
      const handoff = this.pendingSessionHandoffs.get(sessionKey);
      const sessionManager = SessionManager.create(
        workspaceDir,
        sessionDir,
        handoff?.parentSession ? { parentSession: handoff.parentSession } : undefined
      );
      const operationalNotes = formatSessionStartOperationalNotes(loadSessionStartOperationalNotes());
      if (operationalNotes) {
        sessionManager.appendCustomMessageEntry(
          "arisa-operational-notes",
          operationalNotes,
          false,
          { source: "session-start" }
        );
      }
      if (handoff?.text) {
        sessionManager.appendCustomMessageEntry(
          "arisa-session-handoff",
          handoff.text,
          false,
          { source: "telegram-new" }
        );
      }
      return { sessionManager, isNewSession: true };
    }
    this.logger?.log("agent", `recovering persisted session for chat ${sessionKey}`);
    return {
      sessionManager: SessionManager.continueRecent(workspaceDir, sessionDir),
      isNewSession: false
    };
  }

  completeNewSession(sessionKey) {
    this.pendingNewSessions.delete(sessionKey);
    this.pendingSessionHandoffs.delete(sessionKey);
  }

  async getDiagnostic() {
    const contexts = await Promise.all([...this.sessions.entries()].map(async ([chatId, context]) => {
      const base = {
        chatId,
        activeUsers: context.activeUsers || 0,
        persistedBytes: context.persistedBytes || 0,
        lastAccessedAt: context.lastAccessedAt || null
      };
      try {
        const stats = context.session.getSessionStats();
        const retained = this.summarizeContext(context.session.messages);
        return {
          ...base,
          ...retained,
          tokens: stats.contextUsage?.tokens ?? null,
          contextWindow: stats.contextUsage?.contextWindow ?? null,
          percent: stats.contextUsage?.percent ?? null
        };
      } catch (error) {
        return { ...base, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    return {
      harness: "pi",
      sessions: this.sessions.size,
      closingSessions: this.sessionClosePromises.size,
      cache: { ...this.cachePolicy, ...this.cacheUsage() },
      contexts
    };
  }

  async closeAll() {
    const contexts = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled([
      ...this.sessionClosePromises.values(),
      ...contexts.map((context) => closeAgentSession(context.session))
    ]);
  }
}
