import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { persistDeviceSession, persistDeviceSourceSession } from "../session-store.js";
import { assertFreshCapture, deleteDeviceState, deleteSelectedSession, importReceiptPath, readImportReceipt, writeImportReceipt } from "../import-receipts.js";

const deviceId = "d".repeat(24);
test("delete removes both cookie copies; device revoke also removes import receipts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-delete-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = { resourceId: "example.com", cookies: [{ name: "sid", value: "FAKE" }] };
  const sessionPath = await persistDeviceSession(root, deviceId, session);
  const source = await persistDeviceSourceSession(root, deviceId, session);
  const receipt = importReceiptPath(root, deviceId, {}, { operationId: "test-operation" });
  await writeImportReceipt(receipt, { ok: true });
  await deleteSelectedSession(root, { resourceId: session.resourceId, deviceId, sessionPath });
  await assert.rejects(access(source), { code: "ENOENT" });
  await assert.rejects(access(sessionPath), { code: "ENOENT" });
  assert.deepEqual(await readImportReceipt(receipt), { ok: true });
  await deleteDeviceState(root, deviceId);
  await assert.rejects(access(receipt), { code: "ENOENT" });
});

test("old or future captures cannot be replayed after receipt expiry", () => {
  const now = Date.now();
  assertFreshCapture({ capturedAt: new Date(now).toISOString() }, now);
  assert.throws(() => assertFreshCapture({ capturedAt: new Date(now - 11 * 60000).toISOString() }, now));
  assert.throws(() => assertFreshCapture({ capturedAt: new Date(now + 120000).toISOString() }, now));
  assert.throws(() => assertFreshCapture({ capturedAt: "invalid" }, now));
});
