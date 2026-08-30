import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export function normalizedResourceId(value) {
  const resourceId = String(value || "").trim().toLowerCase();
  if (!/^(?=.{1,253}$)[a-z0-9.-]+$/.test(resourceId) || resourceId.includes("..")) throw new Error("A valid resourceId hostname is required");
  return resourceId;
}

export function normalizedDeviceId(value) {
  const deviceId = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{20,100}$/.test(deviceId)) throw new Error("A valid deviceId is required");
  return deviceId;
}

function legacyPath(stateDir, resourceId) {
  return path.join(stateDir, "sessions", `${resourceId}.json`);
}

function devicePath(stateDir, deviceId, resourceId) {
  return path.join(stateDir, "device-sessions", deviceId, `${resourceId}.json`);
}

async function deviceCandidates(stateDir, resourceId) {
  const root = path.join(stateDir, "device-sessions");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{20,100}$/.test(entry.name)) continue;
    const sessionPath = devicePath(stateDir, entry.name, resourceId);
    try {
      await access(sessionPath);
      candidates.push({ deviceId: entry.name, sessionPath });
    } catch {}
  }
  return candidates;
}

export async function resolveStoredSession({ stateDir, resourceId: rawResourceId, deviceId: rawDeviceId }) {
  const resourceId = normalizedResourceId(rawResourceId);
  if (rawDeviceId) {
    const deviceId = normalizedDeviceId(rawDeviceId);
    const sessionPath = devicePath(stateDir, deviceId, resourceId);
    await access(sessionPath).catch(() => { throw new Error(`No ${resourceId} session is stored for browser profile ${deviceId}`); });
    return { resourceId, deviceId, sessionPath };
  }
  const candidates = await deviceCandidates(stateDir, resourceId);
  if (candidates.length > 1) throw new Error(`Multiple browser profiles have a ${resourceId} session; deviceId is required.`);
  if (candidates.length === 1) return { resourceId, ...candidates[0] };
  return { resourceId, deviceId: null, sessionPath: legacyPath(stateDir, resourceId) };
}

function publicSession(record, profile = {}) {
  return {
    resourceId: record.resourceId,
    sourceUrl: record.sourceUrl,
    capturedAt: record.capturedAt,
    receivedAt: record.receivedAt,
    cookieCount: Array.isArray(record.cookies) ? record.cookies.length : 0,
    storageCount: Object.keys(record.webStorage?.local || {}).length + Object.keys(record.webStorage?.session || {}).length,
    ...profile,
    connectionStatus: "session_shared",
    targetValidation: { status: "not_validated", reason: "A consumer must prove the requested target." }
  };
}

export async function listStoredSessions({ stateDir, devices = [] }) {
  const labels = new Map(devices.map((device) => [device.deviceId, device.label]));
  const output = [];
  const profileResources = new Set();
  const profileRoot = path.join(stateDir, "device-sessions");
  const profileDirs = await readdir(profileRoot, { withFileTypes: true }).catch(() => []);
  for (const directory of profileDirs) {
    if (!directory.isDirectory() || !/^[a-zA-Z0-9_-]{20,100}$/.test(directory.name)) continue;
    const files = await readdir(path.join(profileRoot, directory.name)).catch(() => []);
    for (const file of files.filter((name) => /^(?=.{6,258}$)[a-z0-9.-]+\.json$/.test(name))) {
      try {
        const record = JSON.parse(await readFile(path.join(profileRoot, directory.name, file), "utf8"));
        profileResources.add(record.resourceId);
        output.push(publicSession(record, { deviceId: directory.name, profileLabel: labels.get(directory.name) || "Revoked browser profile" }));
      } catch {}
    }
  }
  const legacyRoot = path.join(stateDir, "sessions");
  const legacyFiles = await readdir(legacyRoot).catch(() => []);
  for (const file of legacyFiles.filter((name) => /^(?=.{6,258}$)[a-z0-9.-]+\.json$/.test(name))) {
    try {
      const record = JSON.parse(await readFile(path.join(legacyRoot, file), "utf8"));
      if (!profileResources.has(record.resourceId)) output.push(publicSession(record, { deviceId: null, profileLabel: "Legacy session" }));
    } catch {}
  }
  return output.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
}
