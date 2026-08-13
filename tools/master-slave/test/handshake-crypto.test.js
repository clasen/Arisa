import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBootstrapSecret } from "../lib/bootstrap-url.js";
import {
  deriveSessionKeys,
  encodeHandshakeTranscript,
  generateEphemeralKeyPair,
  generateIdentity,
  identityFingerprint,
  loadOrCreateIdentity,
  signHandshake,
  verifyConnectionSecretProof,
  verifyHandshake,
  proveConnectionSecret
} from "../lib/handshake-crypto.js";

function transcript(masterIdentity, slaveIdentity, masterEphemeral, slaveEphemeral, marker = "one") {
  return encodeHandshakeTranscript([
    ["master_identity", Buffer.from(masterIdentity.publicKey, "base64")],
    ["slave_identity", Buffer.from(slaveIdentity.publicKey, "base64")],
    ["master_ephemeral", masterEphemeral.publicKeyBytes],
    ["slave_ephemeral", slaveEphemeral.publicKeyBytes],
    ["challenge", marker]
  ]);
}

test("canonical transcript is ordered, length-prefixed, signed, and secret-proven", () => {
  const identity = generateIdentity();
  const encoded = encodeHandshakeTranscript([["role", "master"], ["challenge", Buffer.from([1, 2, 3])]]);
  const reordered = encodeHandshakeTranscript([["challenge", Buffer.from([1, 2, 3])], ["role", "master"]]);
  assert.notDeepEqual(encoded, reordered);
  assert.throws(() => encodeHandshakeTranscript([["role", "a"], ["role", "b"]]), /Duplicate/);

  const signature = signHandshake(identity, encoded);
  assert.equal(verifyHandshake(Buffer.from(identity.publicKey, "base64"), encoded, signature), true);
  assert.equal(verifyHandshake(Buffer.from(identity.publicKey, "base64"), reordered, signature), false);
  const secret = Buffer.alloc(32, 7);
  const proof = proveConnectionSecret(secret, encoded);
  assert.equal(verifyConnectionSecretProof(secret, encoded, proof), true);
  assert.equal(verifyConnectionSecretProof(Buffer.alloc(32, 8), encoded, proof), false);
  const canonicalSecret = createBootstrapSecret(() => Buffer.alloc(32, 7));
  assert.deepEqual(proveConnectionSecret(canonicalSecret, encoded), proof);
});

test("persists and reloads one matching Ed25519 identity with restrictive permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-slave-identity-"));
  const file = path.join(root, "private", "identity.json");
  const first = await loadOrCreateIdentity(file);
  const second = await loadOrCreateIdentity(file);
  assert.equal(identityFingerprint(first), identityFingerprint(second));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(file, "utf8")).algorithm, "Ed25519");
});

test("initial pairing derives matching directional keys", () => {
  const masterIdentity = generateIdentity();
  const slaveIdentity = generateIdentity();
  const masterEphemeral = generateEphemeralKeyPair();
  const slaveEphemeral = generateEphemeralKeyPair();
  const encoded = transcript(masterIdentity, slaveIdentity, masterEphemeral, slaveEphemeral);
  const secret = Buffer.alloc(32, 0x33);
  const master = deriveSessionKeys({
    localPrivateKey: masterEphemeral.privateKey,
    remotePublicKeyBytes: slaveEphemeral.publicKeyBytes,
    connectionSecret: secret,
    transcript: encoded,
    role: "master"
  });
  const slave = deriveSessionKeys({
    localPrivateKey: slaveEphemeral.privateKey,
    remotePublicKeyBytes: masterEphemeral.publicKeyBytes,
    connectionSecret: secret,
    transcript: encoded,
    role: "slave"
  });
  assert.deepEqual(master.send, slave.receive);
  assert.deepEqual(master.receive, slave.send);
  assert.notDeepEqual(master.send.key, master.receive.key);
});

test("reconnects without the bootstrap secret and rotates session keys", () => {
  const masterIdentity = generateIdentity();
  const slaveIdentity = generateIdentity();
  const derive = (marker) => {
    const masterEphemeral = generateEphemeralKeyPair();
    const slaveEphemeral = generateEphemeralKeyPair();
    const encoded = transcript(masterIdentity, slaveIdentity, masterEphemeral, slaveEphemeral, marker);
    const shared = {
      transcript: encoded,
      localIdentityPublicKeyBytes: Buffer.from(masterIdentity.publicKey, "base64"),
      remoteIdentityPublicKeyBytes: Buffer.from(slaveIdentity.publicKey, "base64")
    };
    const master = deriveSessionKeys({ ...shared, localPrivateKey: masterEphemeral.privateKey, remotePublicKeyBytes: slaveEphemeral.publicKeyBytes, role: "master" });
    const slave = deriveSessionKeys({
      transcript: encoded,
      localIdentityPublicKeyBytes: Buffer.from(slaveIdentity.publicKey, "base64"),
      remoteIdentityPublicKeyBytes: Buffer.from(masterIdentity.publicKey, "base64"),
      localPrivateKey: slaveEphemeral.privateKey,
      remotePublicKeyBytes: masterEphemeral.publicKeyBytes,
      role: "slave"
    });
    assert.deepEqual(master.send, slave.receive);
    return master;
  };
  const first = derive("first");
  const second = derive("second");
  assert.notDeepEqual(first.send.key, second.send.key);
  assert.notDeepEqual(first.send.nonceSalt, second.send.nonceSalt);
});
