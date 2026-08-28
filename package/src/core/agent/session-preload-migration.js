import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  findMostRecentSessionFile,
  inspectSessionForPreloadMigration
} from "./session-history-reader.js";
import { normalizeSessionRotationPolicy } from "./session-rotation.js";

const contextEntryTypes = new Set([
  "message",
  "custom_message",
  "branch_summary",
  "thinking_level_change",
  "model_change"
]);

function createEntry(type, parentId, fields = {}) {
  return {
    type,
    ...fields,
    id: randomUUID(),
    parentId,
    timestamp: fields.timestamp || new Date().toISOString()
  };
}

function appendDurably(filePath, entry) {
  writeFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
}

function syncFile(filePath) {
  const descriptor = openSync(filePath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(directory) {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function migratedEntry(source, parentId) {
  const { id: _id, parentId: _parentId, ...fields } = source;
  return createEntry(source.type, parentId, fields);
}

export function createPreloadMigrationChild({
  sessionDir,
  cwd,
  migration,
  operationalNotes = "",
  now = new Date()
}) {
  const timestamp = now.toISOString();
  const sessionId = randomUUID();
  const filenameTimestamp = timestamp.replace(/[:.]/g, "-");
  const targetFile = path.join(sessionDir, `${filenameTimestamp}_${sessionId}.jsonl`);
  const temporaryFile = path.join(sessionDir, `.session-migration-${sessionId}.tmp`);
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp,
    cwd,
    parentSession: migration.sourceFile
  };
  let parentId = null;
  let copiedEntries = 0;

  try {
    writeFileSync(temporaryFile, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
    const notes = String(operationalNotes || "").trim();
    if (notes) {
      const entry = createEntry("custom_message", parentId, {
        customType: "arisa-operational-notes",
        content: notes,
        display: false,
        details: { source: "session-start" }
      });
      appendDurably(temporaryFile, entry);
      parentId = entry.id;
    }
    const handoff = createEntry("custom_message", parentId, {
      customType: "arisa-session-handoff",
      content: [
        "Automatic session migration before loading. Continue from this checkpoint:",
        "",
        migration.summary
      ].join("\n"),
      display: false,
      details: { source: "preload-migration" }
    });
    appendDurably(temporaryFile, handoff);
    parentId = handoff.id;

    for (const sourceEntry of migration.contextEntries) {
      if (!contextEntryTypes.has(sourceEntry.type)) continue;
      const entry = migratedEntry(sourceEntry, parentId);
      appendDurably(temporaryFile, entry);
      parentId = entry.id;
      copiedEntries += 1;
    }

    syncFile(temporaryFile);
    renameSync(temporaryFile, targetFile);
    syncDirectory(sessionDir);
    return {
      sourceFile: migration.sourceFile,
      sourceBytes: migration.sourceBytes,
      targetFile,
      targetBytes: statSync(targetFile).size,
      copiedEntries
    };
  } catch (error) {
    try {
      unlinkSync(temporaryFile);
    } catch {}
    throw error;
  }
}

export function migrateRecentSessionBeforeLoad({
  sessionDir,
  cwd,
  policy,
  operationalNotes = ""
}) {
  const normalized = normalizeSessionRotationPolicy(policy);
  if (!normalized.enabled) return null;
  const sourceFile = findMostRecentSessionFile(sessionDir, cwd);
  if (!sourceFile) return null;
  const sourceBytes = statSync(sourceFile).size;
  if (sourceBytes <= normalized.maxPersistedBytes) return null;
  const migration = inspectSessionForPreloadMigration(sourceFile, normalized.maxPersistedBytes);
  if (!migration) {
    const error = new Error("Oversized Pi session could not be migrated safely before loading");
    error.code = "PI_SESSION_PRELOAD_MIGRATION_UNAVAILABLE";
    throw error;
  }
  return createPreloadMigrationChild({
    sessionDir,
    cwd,
    migration,
    operationalNotes
  });
}
