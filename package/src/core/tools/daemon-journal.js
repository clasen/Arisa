import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const defaultRetentionMs = 24 * 60 * 60_000;
const defaultMaxCompleted = 2_048;
const operationBatchSize = 64;

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function resultId(file) {
  return file.endsWith(".result.json") ? file.slice(0, -".result.json".length) : "";
}

function activeId(file) {
  return file.replace(/\.(?:request|processing)\.json$/, "");
}

async function entries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function inBatches(items, operation) {
  for (let index = 0; index < items.length; index += operationBatchSize) {
    await Promise.all(items.slice(index, index + operationBatchSize).map(operation));
  }
}

async function completedRecords(directory, location, directoryEntries) {
  const records = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".result.json"))
    .map((entry) => ({
      id: resultId(entry.name),
      name: entry.name,
      file: path.join(directory, entry.name),
      location,
      mtimeMs: 0
    }));
  await inBatches(records, async (record) => {
    record.mtimeMs = (await stat(record.file)).mtimeMs;
  });
  return records;
}

async function moveLegacyResult(record, resultsDir) {
  const destination = path.join(resultsDir, record.name);
  try {
    await rename(record.file, destination);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await rm(record.file, { force: true });
  }
}

export async function ensureDaemonJournal(paths) {
  await Promise.all([
    mkdir(paths.commandsDir, { recursive: true }),
    mkdir(paths.resultsDir, { recursive: true })
  ]);
}

export async function maintainDaemonJournal(paths, policy = {}, { now = Date.now } = {}) {
  const startedAt = Date.now();
  await ensureDaemonJournal(paths);
  const [commandEntries, resultEntries] = await Promise.all([
    entries(paths.commandsDir),
    entries(paths.resultsDir)
  ]);
  const activeIds = new Set(commandEntries
    .filter((entry) => entry.isFile() && /\.(?:request|processing)\.json$/.test(entry.name))
    .map((entry) => activeId(entry.name)));
  const completed = [
    ...await completedRecords(paths.resultsDir, "results", resultEntries),
    ...await completedRecords(paths.commandsDir, "legacy", commandEntries)
  ].sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  const retentionMs = positiveInteger(policy.journalRetentionMs, defaultRetentionMs);
  const maxCompleted = positiveInteger(policy.journalMaxCompleted, defaultMaxCompleted);
  const cutoff = now() - retentionMs;
  const seen = new Set();
  const retained = [];
  const removed = [];
  let retainedCompleted = 0;

  for (const record of completed) {
    const duplicate = seen.has(record.id);
    const protectedByActiveJob = activeIds.has(record.id);
    const withinRetention = record.mtimeMs >= cutoff;
    const withinLimit = retainedCompleted < maxCompleted;
    if (!duplicate && (protectedByActiveJob || (withinRetention && withinLimit))) {
      seen.add(record.id);
      retained.push(record);
      if (!protectedByActiveJob) retainedCompleted += 1;
    } else {
      removed.push(record);
    }
  }

  await inBatches(removed, (record) => rm(record.file, { force: true }));
  const legacy = retained.filter((record) => record.location === "legacy");
  await inBatches(legacy, (record) => moveLegacyResult(record, paths.resultsDir));

  return {
    active: activeIds.size,
    completed: retained.length,
    migrated: legacy.length,
    pruned: removed.length,
    scanMs: Math.max(0, Date.now() - startedAt)
  };
}
