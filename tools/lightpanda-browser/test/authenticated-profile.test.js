import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { assertResourceUrl, createAuthenticatedProfileStore } from "../authenticated-profile.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lp-auth-profile-"));
  const bridgeStateDir = path.join(root, "bridge");
  const toolStateDir = path.join(root, "lightpanda");
  const tmpDir = path.join(root, "tmp");
  await mkdir(path.join(bridgeStateDir, "sessions"), { recursive: true });
  await writeFile(path.join(bridgeStateDir, "sessions", "example.com.json"), JSON.stringify({
    version: 1,
    resourceId: "example.com",
    sourceUrl: "https://example.com",
    capturedAt: "2026-08-28T00:00:00.000Z",
    receivedAt: "2026-08-28T00:00:01.000Z",
    cookies: [{ name: "sid", value: "secret", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", session: true }]
  }));
  return { root, bridgeStateDir, toolStateDir, tmpDir, store: createAuthenticatedProfileStore({ bridgeStateDir, toolStateDir, tmpDir }) };
}

test("authenticated profile materializes private runtime cookies and refreshes the bridge", async () => {
  const setup = await fixture();
  try {
    const profile = await setup.store.open("example.com");
    assert.equal(profile.publicMetadata.authenticated, true);
    assert.equal(profile.publicMetadata.resourceId, "example.com");
    const imported = JSON.parse(await readFile(profile.cookiePath, "utf8"));
    assert.equal(imported[0].value, "secret");
    await writeFile(profile.cookieJarPath, JSON.stringify([{ name: "sid", value: "fresh", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", expires: 2_000_000_000 }]));
    await profile.finish({ refresh: true });
    const stored = JSON.parse(await readFile(path.join(setup.bridgeStateDir, "sessions", "example.com.json"), "utf8"));
    assert.equal(stored.cookies[0].value, "fresh");
    assert.equal(stored.cookies[0].expirationDate, 2_000_000_000);
    await assert.rejects(access(path.dirname(profile.cookiePath)));
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("authenticated profile isolates the same domain by browser profile", async () => {
  const setup = await fixture();
  const deviceId = "device_profile_identifier_123";
  try {
    const legacyPath = path.join(setup.bridgeStateDir, "sessions", "example.com.json");
    const deviceDir = path.join(setup.bridgeStateDir, "device-sessions", deviceId);
    const devicePath = path.join(deviceDir, "example.com.json");
    await mkdir(deviceDir, { recursive: true });
    const deviceRecord = JSON.parse(await readFile(legacyPath, "utf8"));
    deviceRecord.cookies[0].value = "profile-secret";
    await writeFile(devicePath, JSON.stringify(deviceRecord));
    const profile = await setup.store.open("example.com", deviceId);
    assert.equal(profile.publicMetadata.deviceId, deviceId);
    assert.equal(JSON.parse(await readFile(profile.cookiePath, "utf8"))[0].value, "profile-secret");
    await writeFile(profile.cookieJarPath, JSON.stringify([{ ...deviceRecord.cookies[0], value: "profile-fresh" }]));
    await profile.finish({ refresh: true });
    assert.equal(JSON.parse(await readFile(devicePath, "utf8")).cookies[0].value, "profile-fresh");
    assert.equal(JSON.parse(await readFile(legacyPath, "utf8")).cookies[0].value, "secret");
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("authenticated profile accepts storage-only bridge sessions", async () => {
  const setup = await fixture();
  try {
    const sessionPath = path.join(setup.bridgeStateDir, "sessions", "example.com.json");
    const record = JSON.parse(await readFile(sessionPath, "utf8"));
    record.version = 2;
    record.cookies = [];
    record.webStorage = { local: { auth: "stored" }, session: {} };
    await writeFile(sessionPath, JSON.stringify(record));
    const profile = await setup.store.open("example.com");
    assert.deepEqual(profile.webStorage.local, { auth: "stored" });
    assert.deepEqual(JSON.parse(await readFile(profile.cookiePath, "utf8")), []);
    await profile.finish({ refresh: false });
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("authenticated profile refuses cross-site cookies and navigation", async () => {
  const setup = await fixture();
  try {
    const sessionPath = path.join(setup.bridgeStateDir, "sessions", "example.com.json");
    const record = JSON.parse(await readFile(sessionPath, "utf8"));
    record.cookies[0].domain = ".evil.example";
    await writeFile(sessionPath, JSON.stringify(record));
    await assert.rejects(setup.store.open("example.com"), /outside the authenticated resource scope/);
    assert.equal(assertResourceUrl("https://sub.example.com/account", "example.com").hostname, "sub.example.com");
    assert.throws(() => assertResourceUrl("https://accounts.example.net/", "example.com"), /left the shared session scope/);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("newer bridge imports are not overwritten by an older Lightpanda close", async () => {
  const setup = await fixture();
  try {
    const profile = await setup.store.open("example.com");
    const sessionPath = path.join(setup.bridgeStateDir, "sessions", "example.com.json");
    const newer = JSON.parse(await readFile(sessionPath, "utf8"));
    newer.receivedAt = "2026-08-28T00:00:02.000Z";
    newer.cookies[0].value = "newer-bridge";
    await writeFile(sessionPath, JSON.stringify(newer));
    await writeFile(profile.cookieJarPath, JSON.stringify([{ ...newer.cookies[0], value: "stale-lightpanda" }]));
    await profile.finish({ refresh: true });
    assert.equal(JSON.parse(await readFile(sessionPath, "utf8")).cookies[0].value, "newer-bridge");
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});
