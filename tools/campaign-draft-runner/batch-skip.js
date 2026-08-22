import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function safeProfileName(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9._-]/g, "-");
}

function stateFile(stateDir, profileName) {
  return path.join(stateDir, "batch-skip", `${safeProfileName(profileName)}.json`);
}

async function readGateState(stateDir, profileName) {
  try {
    return JSON.parse(await readFile(stateFile(stateDir, profileName), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeGateState(stateDir, profileName, state) {
  const file = stateFile(stateDir, profileName);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

export function campaignStateFingerprint({ profile, campaign, draftRecipients, discovery, factStatus }) {
  const material = canonicalize({
    profile,
    campaign,
    draftRecipients: [...(draftRecipients || [])].map(String).sort(),
    discovery: discovery || null,
    facts: factStatus || null
  });
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function canArmUnchangedBatchSkip(output) {
  return output?.action === "run-batch"
    && output.dryRun !== true
    && Number(output.drafted || 0) === 0
    && Number(output.eligiblePool || 0) === 0
    && (output.selected || []).length === 0
    && Number(output.discovery?.errors || 0) === 0
    && Number(output.creativeDiscovery?.errors || 0) === 0;
}

export async function evaluateUnchangedBatch({
  stateDir,
  profileName,
  fingerprint,
  forceReviewAfterMs,
  force = false,
  now = Date.now()
}) {
  const state = await readGateState(stateDir, profileName);
  if (force) return { skip: false, reason: "forced", state };
  if (!state?.fingerprint) return { skip: false, reason: "first-review", state };
  if (state.fingerprint !== fingerprint) return { skip: false, reason: "state-changed", state };
  const reviewedAt = Date.parse(state.lastFullReviewAt || "");
  if (!Number.isFinite(reviewedAt) || now - reviewedAt >= forceReviewAfterMs) {
    return { skip: false, reason: "periodic-review", state };
  }

  const updated = {
    ...state,
    skippedSinceFull: Number(state.skippedSinceFull || 0) + 1,
    totalSkipped: Number(state.totalSkipped || 0) + 1,
    lastSkippedAt: new Date(now).toISOString()
  };
  await writeGateState(stateDir, profileName, updated);
  return {
    skip: true,
    reason: "unchanged",
    lastFullReviewAt: updated.lastFullReviewAt,
    nextForcedReviewAt: new Date(reviewedAt + forceReviewAfterMs).toISOString(),
    skippedSinceFull: updated.skippedSinceFull,
    totalSkipped: updated.totalSkipped,
    lastFullSummary: updated.lastFullSummary || null
  };
}

export async function recordFullBatchReview({ stateDir, profileName, fingerprint, summary = {}, now = Date.now() }) {
  const previous = await readGateState(stateDir, profileName);
  const state = {
    version: 1,
    profile: profileName,
    fingerprint,
    lastFullReviewAt: new Date(now).toISOString(),
    lastFullSummary: summary,
    skippedSinceFull: 0,
    totalSkipped: Number(previous?.totalSkipped || 0)
  };
  await writeGateState(stateDir, profileName, state);
  return state;
}
