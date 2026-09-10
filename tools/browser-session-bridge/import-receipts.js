import crypto from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";

export function importReceiptPath(stateDir, deviceId, envelope, payload) {
  const identity = payload.operationId || `${envelope.iv}:${envelope.ciphertext}`;
  if (typeof identity !== "string" || identity.length > 6 * 1024 * 1024) throw new Error("Invalid operation identifier");
  const hash = crypto.createHash("sha256").update(identity).digest("hex");
  return path.join(stateDir, "device-import-receipts", deviceId, `${hash}.json`);
}

export async function readImportReceipt(file) {
  try {
    const receipt = JSON.parse(await readFile(file, "utf8"));
    if (receipt.expiresAt <= Date.now()) { await rm(file, { force: true }); return null; }
    return receipt.result;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function assertFreshCapture(payload, now = Date.now()) {
  const at = Date.parse(payload.capturedAt);
  if (!Number.isFinite(at) || now - at > 10 * 60 * 1000 || at > now + 60000) throw new Error("Session capture expired; explicitly share a fresh session");
}

export async function writeImportReceipt(file, result) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of await readdir(directory)) {
    if (/^[a-f0-9]{64}\.json$/.test(name)) await readImportReceipt(path.join(directory, name));
  }
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ expiresAt: Date.now() + 86400000, result }), { mode: 0o600 });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

export async function deleteDeviceState(stateDir, deviceId) {
  for (const directory of ["device-sessions", "device-source-sessions", "device-import-receipts"]) {
    await rm(path.join(stateDir, directory, deviceId), { recursive: true, force: true });
  }
}

export async function deleteSelectedSession(stateDir, selected) {
  await rm(selected.sessionPath, { force: true });
  if (selected.deviceId) {
    await rm(path.join(stateDir, "device-source-sessions", selected.deviceId, `${selected.resourceId}.json`), { force: true });
    // Keep import receipts until expiry so replay cannot undo an explicit delete.
  }
}
