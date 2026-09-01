import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistSession, refreshSessionOnBrowserClose, refreshedSession, validateSessionPayload } from "../session-store.js";

const session = {
  version: 1,
  resourceId: "chrome.google.com",
  sourceUrl: "https://chrome.google.com",
  capturedAt: "2026-08-15T00:00:00.000Z",
  receivedAt: "2026-08-15T00:00:01.000Z",
  cookies: [{ name: "sid", value: "old", domain: ".google.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: 1 }]
};

test("keeps refreshed cookies inside the original resource scope", () => {
  const refreshed = refreshedSession(session, [
    { name: "sid", value: "new", domain: ".google.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: 2_000_000_000 },
    { name: "chrome", value: "local", domain: "chrome.google.com", path: "/", secure: true, httpOnly: false, sameSite: "Strict", expires: -1 },
    { name: "accounts", value: "excluded", domain: "accounts.google.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: -1 },
    { name: "other", value: "excluded", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "None", expires: -1 }
  ], "2026-08-15T00:05:00.000Z");

  assert.equal(refreshed.refreshedAt, "2026-08-15T00:05:00.000Z");
  assert.equal(refreshed.receivedAt, session.receivedAt);
  assert.deepEqual(refreshed.cookies.map((cookie) => [cookie.name, cookie.value, cookie.domain]), [
    ["sid", "new", ".google.com"],
    ["chrome", "local", "chrome.google.com"]
  ]);
  assert.equal(refreshed.cookies[0].expirationDate, 2_000_000_000);
  assert.equal(refreshed.cookies[1].session, true);
});

test("accepts a storage-only session and bounds its values", () => {
  const normalized = validateSessionPayload({
    version: 2,
    resourceId: "creatorscout.dev",
    sourceUrl: "https://creatorscout.dev/saved",
    capturedAt: "2026-08-29T00:00:00.000Z",
    cookies: [],
    webStorage: { local: { session: "token" }, session: {} }
  });
  assert.equal(normalized.version, 2);
  assert.deepEqual(normalized.cookies, []);
  assert.deepEqual(normalized.webStorage.local, { session: "token" });
});

test("does not erase a session when no refreshed cookie remains in scope", () => {
  assert.equal(refreshedSession(session, [
    { name: "accounts", value: "excluded", domain: "accounts.google.com", path: "/", sameSite: "Lax", expires: -1 }
  ]), null);
});

test("does not refresh a shared session when target validation fails", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "bridge-refresh-gate-"));
  let browserClosed = false;
  try {
    await persistSession(stateDir, session);
    const browser = { close: async () => { browserClosed = true; } };
    const context = {
      cookies: async () => [{ name: "sid", value: "failed-attempt", domain: ".google.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: 2_000_000_000 }]
    };
    refreshSessionOnBrowserClose({ browser, context, stateDir, session, shouldPersist: () => false });
    await browser.close();
    const stored = JSON.parse(await readFile(path.join(stateDir, "sessions", "chrome.google.com.json"), "utf8"));
    assert.equal(browserClosed, true);
    assert.equal(stored.cookies[0].value, "old");
    assert.equal(stored.refreshedAt, undefined);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
