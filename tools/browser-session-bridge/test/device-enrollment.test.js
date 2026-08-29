import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDevice, createReviewerAccess, listDevices, revokeReviewerAccess, startBridgeServer } from "../bridge-server.js";
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
  const reviewersDir = path.join(root, "reviewers");
  const stateDir = path.join(root, "chat");
  const deviceEvents = [];
  const sessionEvents = [];
  const server = await startBridgeServer({
    host: "127.0.0.1",
    port: 0,
    pairingsDir,
    enrollmentsDir,
    devicesDir,
    reviewersDir,
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
    storageCount: 0,
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

  const privacy = await fetch(`${endpoint}/privacy`);
  const privacyText = await privacy.text();
  assert.equal(privacy.status, 200);
  assert.equal(privacy.headers.get("content-type"), "text/html; charset=UTF-8");
  assert.equal(privacy.headers.get("content-language"), "en");
  assert.equal(privacy.headers.get("referrer-policy"), "no-referrer");
  assert.match(privacyText, /Arisa Session Bridge Privacy Policy/);
  assert.match(privacyText, /does not sell user data/);

  const privacyHead = await fetch(`${endpoint}/privacy`, { method: "HEAD" });
  assert.equal(privacyHead.status, 200);
  assert.equal(privacyHead.headers.get("content-type"), "text/html; charset=UTF-8");
  assert.equal(await privacyHead.text(), "");
});

test("mints short-lived enrollments from one durable revocable reviewer credential", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-bridge-reviewer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const enrollmentsDir = path.join(root, "enrollments");
  const reviewersDir = path.join(root, "reviewers");
  const server = await startBridgeServer({
    host: "127.0.0.1",
    port: 0,
    pairingsDir: path.join(root, "pairings"),
    enrollmentsDir,
    devicesDir: path.join(root, "devices"),
    reviewersDir,
    maxBodyBytes: 1_048_576,
    maxCookies: 500,
    stateDirForChat: () => path.join(root, "chat")
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const reviewer = await createReviewerAccess({ reviewersDir, chatId: "chat-1", endpoint });
  const token = new URL(reviewer.reviewerUrl).hash.slice(1);

  const page = await fetch(`${endpoint}/reviewer`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");

  const enrollment = await fetch(`${endpoint}/v1/reviewer-enrollment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  assert.equal(enrollment.status, 200);
  const body = await enrollment.json();
  assert.ok(body.setupUrl.startsWith(`${endpoint}/connect#`));
  assert.ok(new Date(body.expiresAt).getTime() > Date.now());

  assert.equal(await revokeReviewerAccess(reviewersDir, "chat-1"), 1);
  await new Promise((resolve) => setTimeout(resolve, 5100));
  const revoked = await fetch(`${endpoint}/v1/reviewer-enrollment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  assert.equal(revoked.status, 400);
});
