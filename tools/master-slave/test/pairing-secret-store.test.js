import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PairingSecretStore } from "../lib/pairing-secret-store.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-slave-secrets-"));
  let now = Date.parse("2026-08-13T12:00:00.000Z");
  let byte = 1;
  const file = path.join(root, "private", "pairing-secrets.json");
  const store = new PairingSecretStore({
    file,
    ttlMs: 600000,
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, byte++)
  });
  return { file, store, advance: (ms) => { now += ms; } };
}

test("creates chat-bound 10-minute secrets, rotates prior values, and exposes no secret", async () => {
  const { file, store } = await fixture();
  const first = await store.create({ chatId: "chat-a", endpoint: "tcp://192.0.2.1:4719" });
  const second = await store.create({ chatId: "chat-a", endpoint: "tcp://192.0.2.1:4719" });
  assert.notEqual(first.secret, second.secret);
  assert.equal(Date.parse(second.expiresAt) - Date.parse(second.createdAt), 600000);
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].secretId, undefined);
  assert.equal(listed[0].id, second.secretId);
  assert.equal(JSON.stringify(listed).includes(second.secret), false);
  assert.equal(JSON.stringify(listed).includes("digest"), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, "utf8")).records[0].secret, second.secret);
  await assert.rejects(() => store.consume(first.secret), /unknown, expired, rotated/);
});

test("consumes by digest without a supplied chat while rejecting a wrong explicit chat", async () => {
  const { store } = await fixture();
  const issued = await store.create({ chatId: "chat-a", endpoint: "tcp://192.0.2.1:4719" });
  await assert.rejects(() => store.consume(issued.secret, { chatId: "chat-b" }), /does not belong/);
  assert.equal((await store.list()).length, 1);
  const consumed = await store.consume(issued.secret);
  assert.equal(consumed.chatId, "chat-a");
  await assert.rejects(() => store.consume(issued.secret), /already consumed/);
});

test("claims full secret for handshake and consumes only after explicit success", async () => {
  const { store } = await fixture();
  const issued = await store.create({ chatId: "chat-a", endpoint: "tcp://192.0.2.1:4719" });
  const claim = await store.claim(issued.secretId);
  assert.equal(claim.secret, issued.secret);
  assert.equal(claim.chatId, "chat-a");
  assert.equal(JSON.stringify(await store.list()).includes(issued.secret), false);
  await assert.rejects(() => store.claim(issued.secretId), /active pairing claim/);
  await store.releaseClaim(claim.secretId, claim.claimToken);
  const retry = await store.claim(issued.secretId, { chatId: "chat-a" });
  await store.consumeClaim(retry.secretId, retry.claimToken);
  await assert.rejects(() => store.claim(issued.secretId), /already consumed/);
});

test("expired secrets cannot be claimed or consumed", async () => {
  const { store, advance } = await fixture();
  const issued = await store.create({ chatId: "chat-a", endpoint: "tcp://192.0.2.1:4719" });
  advance(600001);
  await assert.rejects(() => store.claim(issued.secretId), /expired/);
  await assert.rejects(() => store.consume(issued.secret), /expired/);
  assert.deepEqual(await store.list(), []);
});
