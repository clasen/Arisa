import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDevice, listDevices, startBridgeServer } from "../bridge-server.js";
import { decryptEnvelope, encryptEnvelope } from "../session-store.js";

function decodeEnrollment(code) {
  const prefix = "arisa-enroll://";
  assert.ok(code.startsWith(prefix));
  return JSON.parse(Buffer.from(code.slice(prefix.length), "base64url").toString("utf8"));
}

test("activates a short-lived device enrollment exactly once", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-bridge-enroll-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pairingsDir = path.join(root, "pairings");
  const enrollmentsDir = path.join(root, "enrollments");
  const devicesDir = path.join(root, "devices");
  const stateDir = path.join(root, "chat");
  const deviceEvents = [];
  const sessionEvents = [];
  const server = await startBridgeServer({
    host: "127.0.0.1",
    port: 0,
    pairingsDir,
    enrollmentsDir,
    devicesDir,
    maxBodyBytes: 1_048_576,
    maxCookies: 500,
    stateDirForChat: () => stateDir,
    onDeviceActivated: async (event) => { deviceEvents.push(event); },
    onSessionImported: async (event) => { sessionEvents.push(event); }
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}`;
  const enrollment = await createDevice({
    enrollmentsDir,
    chatId: "chat-1",
    endpoint,
    label: "Arisa profile",
    ttlSeconds: 600
  });
  const setup = decodeEnrollment(enrollment.code);
  assert.equal(enrollment.setupUrl, `${endpoint}/connect#${encodeURIComponent(enrollment.code)}`);
  assert.equal(setup.endpoint, endpoint);
  assert.equal(setup.deviceId, undefined);
  assert.equal(setup.secret, undefined);

  const activation = encryptEnvelope(setup.activationSecret, { version: 1, action: "activate" });
  const first = await fetch(`${endpoint}/v1/activate-device`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: setup.token, ...activation })
  });
  assert.equal(first.status, 200);
  const body = await first.json();
  const device = decryptEnvelope(setup.activationSecret, body);
  assert.ok(device.deviceId);
  assert.ok(device.secret);
  assert.deepEqual(deviceEvents, [{
    chatId: "chat-1",
    deviceId: device.deviceId,
    label: "Arisa profile",
    createdAt: enrollment.createdAt
  }]);
  assert.deepEqual(await listDevices(devicesDir, "chat-1"), [{
    deviceId: device.deviceId,
    label: "Arisa profile",
    createdAt: enrollment.createdAt,
    lastUsedAt: null
  }]);

  const imported = encryptEnvelope(device.secret, {
    version: 1,
    resourceId: "example.com",
    sourceUrl: "https://example.com/private",
    capturedAt: new Date().toISOString(),
    cookies: [{ name: "sid", value: "secret", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", session: true }]
  });
  const importResponse = await fetch(`${endpoint}/v1/import-device`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: device.deviceId, ...imported })
  });
  assert.equal(importResponse.status, 200);
  assert.equal(sessionEvents.length, 1);
  assert.deepEqual(sessionEvents[0], {
    chatId: "chat-1",
    deviceId: device.deviceId,
    label: "Arisa profile",
    resourceId: "example.com",
    sourceUrl: "https://example.com",
    cookieCount: 1,
    receivedAt: sessionEvents[0].receivedAt
  });

  const repeated = await fetch(`${endpoint}/v1/activate-device`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: setup.token, ...activation })
  });
  assert.equal(repeated.status, 400);

  const page = await fetch(`${endpoint}/connect`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /arisa<span>\.session<\/span>/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
});
