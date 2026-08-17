import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function safeName(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9_-]/g, "-");
}

async function readState(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, facts: {} };
    throw error;
  }
}

async function writeState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

function fieldDefinitions(profile) {
  return Array.isArray(profile.factSheet?.fields) ? profile.factSheet.fields : [];
}

function factFile(stateDir, profile) {
  return path.join(stateDir, "facts", `${safeName(profile.name)}.json`);
}

export async function updateApprovedFacts(stateDir, profile, facts, approvedBy) {
  if (!profile.factSheet) throw new Error(`Profile ${profile.name} has no factSheet configuration`);
  if (!approvedBy || !String(approvedBy).trim()) throw new Error("approvedBy is required");
  if (!facts || typeof facts !== "object" || Array.isArray(facts) || !Object.keys(facts).length) {
    throw new Error("facts must be a non-empty JSON object");
  }
  const allowed = new Set(fieldDefinitions(profile).map((field) => field.key));
  const unsupported = Object.keys(facts).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new Error(`Unknown fact keys: ${unsupported.join(", ")}`);

  const file = factFile(stateDir, profile);
  const state = await readState(file);
  const approvedAt = new Date().toISOString();
  for (const [key, value] of Object.entries(facts)) {
    if (value === null || value === "") delete state.facts[key];
    else state.facts[key] = { value, approvedBy: String(approvedBy).trim(), approvedAt };
  }
  state.profile = profile.name;
  state.owner = profile.factSheet.owner || String(approvedBy).trim();
  state.reviewedAt = approvedAt;
  await writeState(file, state);
  return factSheetStatusFromState(profile, state);
}

function factSheetStatusFromState(profile, state) {
  const fields = fieldDefinitions(profile);
  const approvedFacts = {};
  const approvals = {};
  const pendingQuestions = [];
  for (const field of fields) {
    const record = state.facts?.[field.key];
    if (record && record.value !== undefined && record.value !== "") {
      approvedFacts[field.key] = record.value;
      approvals[field.key] = { approvedBy: record.approvedBy, approvedAt: record.approvedAt };
    } else if (field.required !== false) {
      pendingQuestions.push({ key: field.key, question: field.question });
    }
  }
  return {
    profile: profile.name,
    owner: state.owner || profile.factSheet?.owner || null,
    reviewedAt: state.reviewedAt || null,
    approvedFacts,
    approvals,
    pendingQuestions,
    complete: pendingQuestions.length === 0,
    policy: "Use only approvedFacts for product claims. Ask the owner when a required fact is pending."
  };
}

export async function getFactSheetStatus(stateDir, profile) {
  if (!profile.factSheet) throw new Error(`Profile ${profile.name} has no factSheet configuration`);
  return factSheetStatusFromState(profile, await readState(factFile(stateDir, profile)));
}
