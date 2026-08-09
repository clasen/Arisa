import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { harnessTransitionsFile } from "./paths.js";

const harnessTransitionVersion = 1;
const phases = new Set(["started", "completed", "failed", "rolled_back"]);
const runtimes = new Set(["pi", "prime"]);

function assertTransitionEvent(event) {
  if (!String(event?.transitionId || "").trim()) {
    throw new Error("Harness transition trace requires a transitionId");
  }
  if (!phases.has(event.phase)) {
    throw new Error(`Unsupported harness transition phase: ${event?.phase || "missing"}`);
  }
  if (!runtimes.has(event.fromRuntime) || !runtimes.has(event.toRuntime)) {
    throw new Error("Harness transition trace requires supported source and target runtimes");
  }
}

function isPrimeOwnerTrace(owner) {
  return Number.isSafeInteger(owner?.pid)
    && owner.pid > 0
    && (owner.processStartId === undefined || typeof owner.processStartId === "string")
    && typeof owner.socketPath === "string"
    && typeof owner.descriptorDir === "string"
    && typeof owner.agentDir === "string"
    && typeof owner.registryDir === "string"
    && typeof owner.appVersion === "string";
}

export async function recordHarnessTransition(event, {
  file = harnessTransitionsFile,
  recordedAt = new Date().toISOString()
} = {}) {
  assertTransitionEvent(event);
  const primeDaemons = event.primeDaemons || [];
  if (!Array.isArray(primeDaemons) || !primeDaemons.every(isPrimeOwnerTrace)) {
    throw new Error("Harness transition trace contains an invalid Prime daemon owner");
  }
  const record = {
    version: harnessTransitionVersion,
    transitionId: event.transitionId,
    phase: event.phase,
    fromRuntime: event.fromRuntime,
    toRuntime: event.toRuntime,
    recordedAt,
    ...(primeDaemons.length ? { primeDaemons } : {})
  };
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "a+", 0o600);
  try {
    if ((await handle.stat()).size === 0) await handle.appendFile("\uFEFF", "utf8");
    await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return record;
}

export async function listHarnessTransitionPrimeOwners({ file = harnessTransitionsFile } = {}) {
  let contents;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const owners = [];
  for (const line of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (
      record?.version !== harnessTransitionVersion
      || !phases.has(record.phase)
      || !runtimes.has(record.fromRuntime)
      || !runtimes.has(record.toRuntime)
      || typeof record.transitionId !== "string"
    ) {
      continue;
    }
    if (record.primeDaemons !== undefined && !Array.isArray(record.primeDaemons)) continue;
    for (const owner of record.primeDaemons || []) {
      if (isPrimeOwnerTrace(owner)) {
        owners.push({ ...owner, transitionId: record.transitionId });
      }
    }
  }
  return owners;
}
