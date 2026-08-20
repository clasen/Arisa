import { readFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getChatPiSessionsDir, sessionStartOperationalNotesFile } from "../../runtime/paths.js";
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
  constructor({ logger, summarizeContext }) {
    this.logger = logger;
    this.summarizeContext = summarizeContext;
    this.sessions = new Map();
    this.pendingNewSessions = new Set();
    this.pendingSessionHandoffs = new Map();
    this.sessionClosePromises = new Map();
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
      const base = { chatId };
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
