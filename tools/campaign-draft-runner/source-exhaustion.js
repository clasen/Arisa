import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TTL_DAYS = 30;
const MAX_RECORDS = 1000;
const ALLOWED_REASONS = new Set(["already-used", "no-public-email", "invalid-contact", "ineligible-source", "duplicate", "blocked-verification"]);

function clean(value) { return String(value || "").trim(); }

function canonicalSourceUrl(value) {
  try {
    const url = new URL(clean(value));
    if (!/^https?:$/.test(url.protocol)) return "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

async function readLedger(file) {
  try {
    const parsed = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    return Array.isArray(parsed.records) ? parsed : { version: 1, records: [] };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, records: [] };
    throw error;
  }
}

async function writeLedger(file, ledger) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  await rm(temporary, { force: true }).catch(() => {});
}

function activeRecords(records, nowMs = Date.now()) {
  return records.filter((record) => Date.parse(record.expiresAt) > nowMs);
}

async function checkExhaustedSources(stateDir, profileName, urls, nowMs = Date.now()) {
  const file = path.join(stateDir, "exhausted-sources", `${profileName}.json`);
  const ledger = await readLedger(file);
  const records = activeRecords(ledger.records, nowMs);
  const byUrl = new Map(records.map((record) => [record.url, record]));
  const checked = [...new Set((urls || []).map(canonicalSourceUrl).filter(Boolean))];
  return {
    active: checked.filter((url) => byUrl.has(url)).map((url) => byUrl.get(url)),
    available: checked.filter((url) => !byUrl.has(url)),
    records,
    file
  };
}

async function recordExhaustedSources(stateDir, profileName, sources, ttlDays = DEFAULT_TTL_DAYS, nowMs = Date.now()) {
  const days = Math.max(1, Math.min(DEFAULT_TTL_DAYS, Number(ttlDays) || DEFAULT_TTL_DAYS));
  const file = path.join(stateDir, "exhausted-sources", `${profileName}.json`);
  const ledger = await readLedger(file);
  const byUrl = new Map(activeRecords(ledger.records, nowMs).map((record) => [record.url, record]));
  let recorded = 0;
  for (const source of sources || []) {
    const url = canonicalSourceUrl(source?.url);
    const reason = clean(source?.reason);
    if (!url) continue;
    if (!ALLOWED_REASONS.has(reason)) throw new Error(`Invalid exhausted-source reason: ${reason || "missing"}`);
    byUrl.set(url, {
      url,
      reason,
      checkedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + days * 86400000).toISOString()
    });
    recorded += 1;
  }
  const records = [...byUrl.values()]
    .sort((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt))
    .slice(0, MAX_RECORDS);
  await writeLedger(file, { version: 1, profile: profileName, records, updatedAt: new Date(nowMs).toISOString() });
  return { recorded, active: records.length, ttlDays: days };
}

export { ALLOWED_REASONS, canonicalSourceUrl, checkExhaustedSources, recordExhaustedSources };
