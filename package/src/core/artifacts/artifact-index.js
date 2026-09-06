import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readLegacyArtifacts } from "./legacy-artifact-reader.js";

const operations = new Map();

async function serialize(file, operation) {
  const previous = operations.get(file) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  operations.set(file, current);
  try {
    return await current;
  } finally {
    if (operations.get(file) === current) operations.delete(file);
  }
}

async function createPrivateFile(file) {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    const handle = await open(file, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

function insertArtifact(db, artifact) {
  db.prepare("INSERT INTO artifacts (id, data) VALUES (?, ?)")
    .run(artifact.id, JSON.stringify(artifact));
}

async function importLegacy(db, legacyFile, chatId) {
  const insert = db.prepare("INSERT INTO artifacts (id, data) VALUES (?, ?)");
  try {
    for await (const artifact of readLegacyArtifacts(legacyFile)) {
      if (!artifact || typeof artifact.id !== "string" || !artifact.id
        || String(artifact.chatId) !== chatId) {
        throw new Error("Invalid artifact identity or chat scope");
      }
      insert.run(artifact.id, JSON.stringify(artifact));
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Artifact index is unreadable: ${legacyFile}`, { cause: error });
    }
  }
}

async function initialize(db, legacyFile, chatId) {
  const version = () => db.prepare("PRAGMA user_version").get().user_version;
  if (version() === 1) return;
  if (version() !== 0) throw new Error("Unsupported artifact database version");
  db.exec("BEGIN IMMEDIATE");
  try {
    // Another process may have completed migration while this connection waited.
    if (version() === 0) {
      db.exec("CREATE TABLE artifacts (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL)");
      await importLegacy(db, legacyFile, chatId);
      db.exec("PRAGMA user_version = 1");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Open only for the operation: no per-chat resident history or idle DB cache.
// SQLite transactions coordinate separate Arisa processes as well as store instances.
export function withArtifactIndex({ databaseFile, legacyFile, chatId }, operation) {
  return serialize(databaseFile, async () => {
    await createPrivateFile(databaseFile);
    const db = new DatabaseSync(databaseFile);
    try {
      db.exec("PRAGMA busy_timeout = 30000; PRAGMA cache_size = -1024; PRAGMA mmap_size = 0; PRAGMA synchronous = FULL");
      await initialize(db, legacyFile, chatId);
      return await operation(db);
    } finally {
      db.close();
    }
  });
}

export function appendArtifact(db, artifact) {
  insertArtifact(db, artifact);
  return artifact;
}

export function getArtifact(db, id) {
  const row = db.prepare("SELECT data FROM artifacts WHERE id = ?").get(id);
  return row ? JSON.parse(row.data) : null;
}

export function listRecentArtifacts(db, limit) {
  const artifacts = [];
  let bytes = 0;
  for (const row of db.prepare("SELECT data FROM artifacts ORDER BY seq DESC LIMIT ?").iterate(limit)) {
    bytes += Buffer.byteLength(row.data, "utf8");
    if (bytes > 16 * 1024 * 1024) {
      throw new RangeError("Recent artifacts exceed 16 MiB; request a smaller limit or retrieve individual IDs");
    }
    artifacts.push(JSON.parse(row.data));
  }
  return artifacts;
}
