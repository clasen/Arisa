import crypto from "node:crypto";
import path from "node:path";
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withLock(lockFile, work) {
  await mkdir(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      try { return await work(); } finally { await handle.close(); await rm(lockFile, { force: true }); }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await stat(lockFile).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 30000) await rm(lockFile, { force: true });
      await sleep(20);
    }
  }
  throw new Error("Timed out waiting for telemetry ledger lock");
}

export async function readDefinitions(stateDir) {
  try { return JSON.parse(await readFile(path.join(stateDir, "definitions.json"), "utf8")); } catch { return {}; }
}

export async function writeDefinitions(stateDir, definitions) {
  await mkdir(stateDir, { recursive: true });
  const target = path.join(stateDir, "definitions.json");
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(definitions, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

export async function appendRecords(stateDir, records) {
  const eventsDir = path.join(stateDir, "events");
  const lockFile = path.join(stateDir, "ledger.lock");
  await withLock(lockFile, async () => {
    await mkdir(eventsDir, { recursive: true });
    const byDay = new Map();
    for (const record of records) {
      const day = record.timestamp.slice(0, 10);
      const list = byDay.get(day) || [];
      list.push({ id: crypto.randomUUID(), ...record });
      byDay.set(day, list);
    }
    for (const [day, items] of byDay) {
      await appendFile(path.join(eventsDir, `${day}.ndjson`), `${items.map((item) => JSON.stringify(item)).join("\n")}\n`, { mode: 0o600 });
    }
  });
}

export async function readEvents(stateDir, { since, until, maximum }) {
  const eventsDir = path.join(stateDir, "events");
  const files = (await readdir(eventsDir).catch(() => [])).filter((name) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)).sort();
  const events = [];
  for (const file of files) {
    const day = file.slice(0, 10);
    if (day < since.toISOString().slice(0, 10) || day > until.toISOString().slice(0, 10)) continue;
    const lines = (await readFile(path.join(eventsDir, file), "utf8")).split("\n").filter(Boolean);
    for (const line of lines) {
      const event = JSON.parse(line);
      const time = new Date(event.timestamp);
      if (time >= since && time <= until) events.push(event);
      if (events.length > maximum) throw new Error(`Query exceeds MAX_QUERY_EVENTS (${maximum})`);
    }
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function pruneEvents(stateDir, before) {
  const eventsDir = path.join(stateDir, "events");
  const files = (await readdir(eventsDir).catch(() => [])).filter((name) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name));
  let removed = 0;
  for (const file of files) {
    if (file.slice(0, 10) < before.toISOString().slice(0, 10)) {
      await rm(path.join(eventsDir, file), { force: true });
      removed += 1;
    }
  }
  return removed;
}
