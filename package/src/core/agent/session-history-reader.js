import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const readBufferBytes = 1024 * 1024;
const supportedSessionVersion = 3;

function parseEntry(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readSessionHeader(filePath) {
  const descriptor = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const line = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0];
    const header = parseEntry(line);
    return header?.type === "session" ? header : null;
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
}

export function findMostRecentSessionFile(sessionDir, cwd) {
  const expectedCwd = path.resolve(cwd);
  try {
    return readdirSync(sessionDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(sessionDir, name))
      .map((filePath) => ({ filePath, header: readSessionHeader(filePath) }))
      .filter(({ header }) => header && typeof header.cwd === "string" && path.resolve(header.cwd) === expectedCwd)
      .map(({ filePath }) => ({ filePath, mtimeMs: statSync(filePath).mtimeMs }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.filePath || null;
  } catch {
    return null;
  }
}

export function streamSessionEntries(filePath, visit) {
  const descriptor = openSync(filePath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(readBufferBytes);
    let pending = "";
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const entry = parseEntry(pending.slice(0, newline));
        if (entry) visit(entry);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.end();
    const entry = parseEntry(pending);
    if (entry) visit(entry);
  } finally {
    closeSync(descriptor);
  }
}

function traceActivePath(entries, leafId) {
  const reversed = [];
  const seen = new Set();
  let currentId = leafId;
  while (currentId) {
    if (seen.has(currentId)) return null;
    seen.add(currentId);
    const entry = entries.get(currentId);
    if (!entry) return null;
    reversed.push(entry);
    currentId = entry.parentId || null;
  }
  return reversed.reverse();
}

function findLatestValidCompaction(path) {
  const pathIndex = new Map(path.map((entry, index) => [entry.id, index]));
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index];
    if (entry.type !== "compaction" || !entry.hasSummary) continue;
    if (!entry.firstKeptEntryId) return { entry, index, firstKeptIndex: index };
    const firstKeptIndex = pathIndex.get(entry.firstKeptEntryId);
    if (firstKeptIndex !== undefined && firstKeptIndex < index) {
      return { entry, index, firstKeptIndex };
    }
  }
  return null;
}

function inspectSessionGraph(filePath) {
  let header = null;
  let firstEntry = true;
  let invalidHeader = false;
  let leafId = null;
  let duplicateId = false;
  const entries = new Map();
  streamSessionEntries(filePath, (entry) => {
    if (firstEntry) {
      firstEntry = false;
      header = entry.type === "session" ? entry : null;
      invalidHeader = !header;
      return;
    }
    if (invalidHeader) return;
    if (!entry.id || entry.type === "session") return;
    if (entries.has(entry.id)) duplicateId = true;
    entries.set(entry.id, {
      id: entry.id,
      parentId: entry.parentId || null,
      type: entry.type,
      firstKeptEntryId: entry.type === "compaction" ? entry.firstKeptEntryId || null : null,
      hasSummary: entry.type === "compaction" && Boolean(String(entry.summary || "").trim())
    });
    leafId = entry.id;
  });
  if (invalidHeader || !header || header.version !== supportedSessionVersion || duplicateId || !leafId) return null;
  const path = traceActivePath(entries, leafId);
  if (!path) return null;
  const compaction = findLatestValidCompaction(path);
  if (!compaction) return null;
  return { header, path, compaction };
}

function loadMigrationPayload(filePath, path, compaction) {
  const before = path.slice(compaction.firstKeptIndex, compaction.index);
  const after = path.slice(compaction.index + 1);
  const contextIds = [...before, ...after].map((entry) => entry.id);
  const wanted = new Set(contextIds);
  const loaded = new Map();
  let summary = "";
  streamSessionEntries(filePath, (entry) => {
    if (entry.id === compaction.entry.id) summary = String(entry.summary || "").trim();
    if (wanted.has(entry.id)) loaded.set(entry.id, entry);
  });
  if (!summary || loaded.size !== wanted.size) return null;
  return {
    summary,
    contextEntries: contextIds.map((id) => loaded.get(id))
  };
}

export function inspectSessionForPreloadMigration(filePath, maxPersistedBytes) {
  const sourceBytes = statSync(filePath).size;
  if (sourceBytes <= Math.max(1, Number(maxPersistedBytes) || 1)) return null;
  const graph = inspectSessionGraph(filePath);
  if (!graph) return null;
  const payload = loadMigrationPayload(filePath, graph.path, graph.compaction);
  if (!payload) return null;
  return {
    sourceFile: filePath,
    sourceBytes,
    header: graph.header,
    compactionId: graph.compaction.entry.id,
    ...payload
  };
}
