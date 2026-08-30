import assert from "node:assert/strict";
import test from "node:test";
import { pendingSetupRecord, restorableSetupCode, setupFailureKind, setupStageMessage } from "../extension/onboarding-state.js";

const now = Date.parse("2026-08-30T22:00:00.000Z");
const code = `arisa-enroll://${Buffer.from("setup").toString("base64url")}`;
const setup = { endpoint: "https://bridge.example/session-bridge", expiresAt: "2026-08-30T22:10:00.000Z" };

test("pending setup survives a popup close until activation or expiry", () => {
  const pending = pendingSetupRecord(code, setup, { resume: true, now });
  assert.equal(pending.resume, true);
  assert.equal(restorableSetupCode(pending, now + 60_000), code);
  assert.equal(restorableSetupCode(pending, now + 11 * 60_000), "");
});

test("onboarding diagnostics store only a bounded failure category and stage copy", () => {
  assert.equal(setupFailureKind(new Error("Temporary network failure"), "activation"), "network");
  assert.equal(setupFailureKind(new Error("Permission was denied"), "permission"), "permission");
  assert.match(setupStageMessage("permission"), /Requesting bridge access/);
  assert.throws(() => pendingSetupRecord("https://example.com/#secret", setup, { now }), /Invalid pending setup code/);
});
