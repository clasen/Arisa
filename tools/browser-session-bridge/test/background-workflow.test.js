import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflow, SETUP, SEND, RESULT } from "../extension/background-workflow.js";
import { pendingSetupRecord, restorableSetupCode } from "../extension/onboarding-state.js";
import { pendingSessionSend } from "../extension/session-send-state.js";
import { validatedEndpoint, parseSetupCode } from "../extension/bridge-client.js";

function fixture() {
  const setup = { version: 1, endpoint: "https://bridge.example", token: "t".repeat(32), activationSecret: Buffer.alloc(32, 1).toString("base64url"), expiresAt: new Date(Date.now() + 600000).toISOString() };
  const code = `arisa-enroll://${Buffer.from(JSON.stringify(setup)).toString("base64url")}`;
  const state = { [SETUP]: pendingSetupRecord(code, setup, { resume: true }) };
  const removed = [];
  let granted = true;
  const api = {
    storage: { local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, state[key]])),
      set: async (values) => Object.assign(state, structuredClone(values)),
      remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; }
    } },
    permissions: { contains: async () => granted, remove: async ({ origins }) => { removed.push(...origins); return true; } },
    tabs: { get: async () => ({ id: 7, url: "https://example.com/watch" }) },
    cookies: { getAll: async () => [{ name: "sid", value: "FAKE", domain: "example.com", path: "/" }] }
  };
  return { setup, code, state, api, removed, grant: (value) => { granted = value; } };
}
const device = { deviceId: "d".repeat(24), endpoint: "https://bridge.example", secret: "test-only" };

test("background activation completes without a popup and duplicate wakes activate once", async () => {
  const f = fixture(); let calls = 0;
  const worker = createWorkflow(f.api, { activate: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return device; } });
  await Promise.all([worker.resume(), worker.resume()]);
  assert.equal(calls, 1);
  assert.deepEqual(f.state.arisaDevice, device);
  assert.equal(f.state[SETUP], undefined);
});

test("worker resumes persisted enrollment after permission arrives or worker restarts", async () => {
  const f = fixture(); f.grant(false); let calls = 0;
  const deps = { activate: async () => { calls++; return device; } };
  await createWorkflow(f.api, deps).resume();
  assert.equal(calls, 0);
  f.grant(true);
  await createWorkflow(f.api, deps).resume();
  assert.equal(calls, 1);
  assert.deepEqual(f.state.arisaDevice, device);
});

test("detected setup without user consent is never activated", async () => {
  const f = fixture(); f.state[SETUP].resume = false;
  await createWorkflow(f.api, { activate: () => assert.fail("no consent") }).resume();
  assert.equal(f.state.arisaDevice, undefined);
});

test("interrupted activation retains recovery state with a bounded retry delay", async () => {
  const f = fixture(); let calls = 0;
  const worker = createWorkflow(f.api, { activate: async () => { calls++; throw new Error("Failed to fetch"); } });
  await worker.resume(); await worker.resume();
  assert.equal(calls, 1);
  assert.equal(f.state[SETUP].resume, true);
  assert.equal(f.state[SETUP].attempts, 1);
  f.state[SETUP].nextAttemptAt = 0;
  await createWorkflow(f.api, { activate: async () => device }).resume();
  assert.deepEqual(f.state.arisaDevice, device);
});

test("failed revocation keeps credentials for retry", async () => {
  const f = fixture(); f.state.arisaDevice = device;
  await createWorkflow(f.api, { post: async () => { throw new Error("offline"); } }).forget();
  assert.deepEqual(f.state.arisaDevice, device);
  assert.match(f.state[RESULT].text, /kept/);
  await createWorkflow(f.api, { post: async () => ({ ok: true }) }).forget();
  assert.equal(f.state.arisaDevice, undefined);
});

function pendingSend(f) {
  delete f.state[SETUP];
  f.state.arisaDevice = device;
  f.state[SEND] = { ...pendingSessionSend({ id: 7 }, new URL("https://example.com/watch")), deviceId: device.deviceId, operationId: "fake-operation", ownedOrigins: ["https://example.com/*"] };
}

test("resumed share removes its own grants and emits an operation id", async () => {
  const f = fixture(); pendingSend(f); let sent;
  await createWorkflow(f.api, { post: async (_device, _route, payload) => { sent = payload; return { resourceId: "example.com" }; } }).resume();
  assert.ok(f.removed.includes("https://example.com/*"));
  assert.equal(f.state[SEND], undefined);
  assert.equal(sent.operationId, "fake-operation:example.com");
});

test("expired share releases temporary grants without capturing cookies", async () => {
  const f = fixture(); pendingSend(f); f.state[SEND].expiresAt = "2000-01-01T00:00:00Z";
  f.api.cookies.getAll = () => assert.fail("expired capture");
  await createWorkflow(f.api).resume();
  assert.deepEqual(f.removed, ["https://example.com/*"]);
  assert.equal(f.state[SEND], undefined);
});

test("pre-existing site grants survive a share", async () => {
  const f = fixture(); pendingSend(f); f.state[SEND].ownedOrigins = [];
  await createWorkflow(f.api, { post: async () => ({ resourceId: "example.com" }) }).resume();
  assert.deepEqual(f.removed, []);
});

test("malformed tab URL releases grants and clears pending share", async () => {
  const f = fixture(); pendingSend(f);
  f.api.tabs.get = async () => ({ id: 7, url: "not a URL" });
  f.api.cookies.getAll = () => assert.fail("invalid tab capture");
  await createWorkflow(f.api).resume();
  assert.deepEqual(f.removed, ["https://example.com/*"]);
  assert.equal(f.state[SEND], undefined);
});

test("failed Forget cancels pending work while keeping retry credentials", async () => {
  const f = fixture(); pendingSend(f);
  f.state[SETUP] = pendingSetupRecord(f.code, f.setup, { resume: true });
  const worker = createWorkflow(f.api, { post: async () => { throw new Error("offline"); } });
  await worker.forget();
  assert.deepEqual(f.state.arisaDevice, device);
  assert.equal(f.state[SEND], undefined);
  assert.equal(f.state[SETUP], undefined);
  assert.deepEqual(f.removed, ["https://example.com/*"]);
  f.api.cookies.getAll = () => assert.fail("cancelled share");
  await worker.resume();
});

test("setup validation rejects remote HTTP and invalid expiry", () => {
  assert.throws(() => validatedEndpoint("http://bridge.example"), /HTTPS/);
  assert.equal(validatedEndpoint("http://localhost:1234/"), "http://localhost:1234");
  const f = fixture();
  assert.equal(parseSetupCode(f.code).endpoint, "https://bridge.example");
  assert.equal(restorableSetupCode({ ...f.state[SETUP], expiresAt: "invalid" }), "");
});
