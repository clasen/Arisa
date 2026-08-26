import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const OUTCOMES = new Set(["drafted", "approved", "sent", "response", "coverage", "no-response", "rejected"]);

function clean(value, limit = 500) {
  return String(value || "").trim().slice(0, limit);
}

function experimentFile(stateDir, profileName) {
  const safeName = clean(profileName, 100).replace(/[^a-z0-9._-]+/gi, "-") || "default";
  return path.join(stateDir, "pitch-experiments", `${safeName}.json`);
}

async function readExperiment(file, profileName) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return { version: 1, profile: profileName, assignments: Array.isArray(parsed.assignments) ? parsed.assignments : [] };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, profile: profileName, assignments: [] };
    throw error;
  }
}

async function writeExperiment(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function selectPitchVariant(contact, profile) {
  const variants = profile.pitchExperiment?.variants || [];
  if (!variants.length) return null;
  const identity = clean(contact.email || contact.outlet || contact.name).toLowerCase();
  const digest = createHash("sha256").update(`${profile.name || "campaign"}:${identity}`).digest();
  return variants[digest.readUInt32BE(0) % variants.length];
}

async function recordPitchAssignment(stateDir, profileName, assignment) {
  const file = experimentFile(stateDir, profileName);
  const experiment = await readExperiment(file, profileName);
  const email = clean(assignment.email, 320).toLowerCase();
  const existing = experiment.assignments.find((item) => item.email === email && item.draftId === assignment.draftId);
  if (existing) return existing;
  const record = {
    email,
    outlet: clean(assignment.outlet, 200),
    variant: clean(assignment.variant, 100),
    draftId: clean(assignment.draftId, 200),
    outcome: "drafted",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  experiment.assignments.push(record);
  await writeExperiment(file, experiment);
  return record;
}

async function recordPitchOutcome(stateDir, profileName, input) {
  const outcome = clean(input.outcome).toLowerCase();
  if (!OUTCOMES.has(outcome)) throw new Error(`outcome must be one of: ${[...OUTCOMES].join(", ")}`);
  const email = clean(input.email, 320).toLowerCase();
  const file = experimentFile(stateDir, profileName);
  const experiment = await readExperiment(file, profileName);
  const record = [...experiment.assignments].reverse().find((item) => item.email === email);
  if (!record) throw new Error("No pitch assignment was found for that email");
  record.outcome = outcome;
  record.note = clean(input.note, 500);
  record.updatedAt = new Date().toISOString();
  await writeExperiment(file, experiment);
  return record;
}

async function pitchExperimentSummary(stateDir, profileName, variantCatalog = []) {
  const experiment = await readExperiment(experimentFile(stateDir, profileName), profileName);
  const variants = Object.fromEntries(variantCatalog.map((variant) => [variant.id, { assigned: 0, approved: 0, sent: 0, responses: 0, coverage: 0, rejected: 0 }]));
  for (const item of experiment.assignments) {
    const metrics = variants[item.variant] || (variants[item.variant] = { assigned: 0, approved: 0, sent: 0, responses: 0, coverage: 0, rejected: 0 });
    metrics.assigned += 1;
    if (item.outcome === "approved") metrics.approved += 1;
    if (["sent", "response", "coverage", "no-response"].includes(item.outcome)) metrics.sent += 1;
    if (item.outcome === "response") metrics.responses += 1;
    if (item.outcome === "coverage") {
      metrics.responses += 1;
      metrics.coverage += 1;
    }
    if (item.outcome === "rejected") metrics.rejected += 1;
  }
  return { assignments: experiment.assignments.length, variants };
}

export { OUTCOMES, pitchExperimentSummary, recordPitchAssignment, recordPitchOutcome, selectPitchVariant };
