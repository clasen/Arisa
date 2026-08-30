import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listStoredSessions, resolveStoredSession } from "../session-selection.js";

const amy = "amy_profile_identifier_123";
const peter = "peter_profile_identifier_1";

function record(value, receivedAt) {
  return {
    version: 2,
    resourceId: "www.threads.com",
    sourceUrl: "https://www.threads.com",
    capturedAt: receivedAt,
    receivedAt,
    cookies: [{ name: "sid", value, domain: ".threads.com", path: "/" }],
    webStorage: { local: {}, session: {} }
  };
}

async function fixture() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "bridge-selection-"));
  await mkdir(path.join(stateDir, "sessions"), { recursive: true });
  await writeFile(path.join(stateDir, "sessions", "www.threads.com.json"), JSON.stringify(record("legacy", "2026-08-30T18:00:00.000Z")));
  for (const [deviceId, value, receivedAt] of [
    [amy, "amy", "2026-08-30T18:01:00.000Z"],
    [peter, "peter", "2026-08-30T18:02:00.000Z"]
  ]) {
    const directory = path.join(stateDir, "device-sessions", deviceId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "www.threads.com.json"), JSON.stringify(record(value, receivedAt)));
  }
  return stateDir;
}

test("same-domain sessions stay isolated and require an explicit profile when ambiguous", async (t) => {
  const stateDir = await fixture();
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await assert.rejects(resolveStoredSession({ stateDir, resourceId: "www.threads.com" }), /deviceId is required/);
  const selected = await resolveStoredSession({ stateDir, resourceId: "www.threads.com", deviceId: amy });
  assert.equal(selected.deviceId, amy);
  assert.match(selected.sessionPath, new RegExp(`${amy}/www\\.threads\\.com\\.json$`));

  const sessions = await listStoredSessions({
    stateDir,
    devices: [{ deviceId: amy, label: "Amy" }, { deviceId: peter, label: "Peter" }]
  });
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map(({ profileLabel, deviceId }) => [profileLabel, deviceId]), [["Peter", peter], ["Amy", amy]]);
});
