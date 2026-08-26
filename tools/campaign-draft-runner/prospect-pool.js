import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const SCORE_LIMITS = {
  thematicFit: 30,
  recentActivity: 20,
  smallIndieCoverage: 15,
  audienceFit: 15,
  publicContact: 10,
  responseLikelihood: 10
};

const STATUSES = new Set(["discovered", "qualified", "dismissed", "promoted"]);

function clean(value, limit = 500) {
  return String(value || "").trim().slice(0, limit);
}

function boundedScore(value, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(maximum, Math.round(number))) : 0;
}

function prospectScore(signals = {}) {
  const normalized = Object.fromEntries(Object.entries(SCORE_LIMITS).map(([key, maximum]) => [key, boundedScore(signals[key], maximum)]));
  return { signals: normalized, total: Object.values(normalized).reduce((sum, value) => sum + value, 0) };
}

function exactPublicUrl(value) {
  const raw = clean(value, 2000);
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) && url.hostname ? url.href : "";
  } catch {
    return "";
  }
}

function canonicalEvidenceUrl(value) {
  const publicUrl = exactPublicUrl(value);
  if (!publicUrl) return "";
  const url = new URL(publicUrl);
  url.hash = "";
  ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((key) => url.searchParams.delete(key));
  return url.href.replace(/\/$/, "");
}

function safeProfileName(value) {
  return clean(value, 100).replace(/[^a-z0-9._-]+/gi, "-") || "default";
}

function poolPaths(stateDir, profileName) {
  const directory = path.join(stateDir, "prospect-pools");
  const stem = safeProfileName(profileName);
  return { directory, file: path.join(directory, `${stem}.json`), lock: path.join(directory, `${stem}.lock`) };
}

async function readPool(file, profileName) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return { version: 1, profile: profileName, prospects: Array.isArray(parsed.prospects) ? parsed.prospects : [] };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, profile: profileName, prospects: [] };
    throw error;
  }
}

async function writePool(file, data) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function acquireLock(lock) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const handle = await open(lock, "wx");
      return async () => {
        await handle.close().catch(() => {});
        await rm(lock, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 60_000) await rm(lock, { force: true }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Prospect pool is busy; retry later.");
}

function normalizedProspect(input, existing = null) {
  const sourceUrl = canonicalEvidenceUrl(input.sourceUrl || existing?.sourceUrl);
  if (!sourceUrl) throw new Error("prospect requires an exact public sourceUrl");
  const segment = clean(input.segment || existing?.segment, 100);
  if (!segment) throw new Error("prospect requires a segment");
  const score = prospectScore(input.scoreSignals || existing?.scoreSignals || {});
  const now = new Date().toISOString();
  return {
    sourceUrl,
    name: clean(input.name || existing?.name, 200),
    outlet: clean(input.outlet || existing?.outlet, 200),
    segment,
    platform: clean(input.platform || existing?.platform, 80),
    evidence: clean(input.evidence || existing?.evidence, 1200),
    contactUrl: exactPublicUrl(input.contactUrl || existing?.contactUrl),
    publicEmail: clean(input.publicEmail || existing?.publicEmail, 320).toLowerCase(),
    status: STATUSES.has(clean(input.status || existing?.status).toLowerCase()) ? clean(input.status || existing?.status).toLowerCase() : "discovered",
    scoreSignals: score.signals,
    score: score.total,
    reason: clean(input.reason || existing?.reason, 500),
    discoveredAt: existing?.discoveredAt || now,
    updatedAt: now
  };
}

async function saveProspect(stateDir, profileName, input) {
  const paths = poolPaths(stateDir, profileName);
  await mkdir(paths.directory, { recursive: true });
  const release = await acquireLock(paths.lock);
  try {
    const pool = await readPool(paths.file, profileName);
    const sourceUrl = canonicalEvidenceUrl(input.sourceUrl);
    const existingIndex = pool.prospects.findIndex((item) => item.sourceUrl === sourceUrl);
    if (existingIndex >= 0) return { prospect: pool.prospects[existingIndex], duplicate: true };
    const prospect = normalizedProspect(input);
    pool.prospects.push(prospect);
    await writePool(paths.file, pool);
    return { prospect, duplicate: false };
  } finally {
    await release();
  }
}

async function updateProspect(stateDir, profileName, input) {
  const paths = poolPaths(stateDir, profileName);
  await mkdir(paths.directory, { recursive: true });
  const release = await acquireLock(paths.lock);
  try {
    const pool = await readPool(paths.file, profileName);
    const sourceUrl = canonicalEvidenceUrl(input.sourceUrl);
    const index = pool.prospects.findIndex((item) => item.sourceUrl === sourceUrl);
    if (index < 0) throw new Error("No matching prospect was found");
    pool.prospects[index] = normalizedProspect(input, pool.prospects[index]);
    await writePool(paths.file, pool);
    return { prospect: pool.prospects[index] };
  } finally {
    await release();
  }
}

async function listProspects(stateDir, profileName, filters = {}) {
  const paths = poolPaths(stateDir, profileName);
  const pool = await readPool(paths.file, profileName);
  const status = clean(filters.status).toLowerCase();
  const segment = clean(filters.segment).toLowerCase();
  const minimumScore = Math.max(0, Number(filters.minimumScore || 0));
  const limit = Math.max(1, Math.min(500, Number(filters.limit || 100)));
  return pool.prospects
    .filter((item) => !status || item.status === status)
    .filter((item) => !segment || item.segment.toLowerCase() === segment)
    .filter((item) => item.score >= minimumScore)
    .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

function summarizeProspects(prospects, target = 40, qualificationScore = 65) {
  const active = prospects.filter((prospect) => prospect.status !== "dismissed");
  const byStatus = {};
  const bySegment = {};
  for (const prospect of prospects) byStatus[prospect.status] = (byStatus[prospect.status] || 0) + 1;
  for (const prospect of active) bySegment[prospect.segment] = (bySegment[prospect.segment] || 0) + 1;
  return {
    total: active.length,
    storedTotal: prospects.length,
    target,
    remaining: Math.max(0, target - active.length),
    qualifiedByScore: active.filter((item) => item.score >= qualificationScore).length,
    withPublicContact: active.filter((item) => item.publicEmail || item.contactUrl).length,
    byStatus,
    bySegment
  };
}

export { SCORE_LIMITS, canonicalEvidenceUrl, listProspects, prospectScore, saveProspect, summarizeProspects, updateProspect };
