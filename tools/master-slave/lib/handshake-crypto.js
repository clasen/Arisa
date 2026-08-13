import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign,
  timingSafeEqual,
  verify
} from "node:crypto";
import { readSecureJson, writeSecureJson } from "./secure-store.js";
import { BOOTSTRAP_SECRET_PREFIX, decodeBootstrapSecret } from "./bootstrap-url.js";

export const HANDSHAKE_DOMAIN = "arisa-master-slave-handshake-v1";

function asBytes(value, field) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new TypeError(`${field} must be a string or bytes`);
}

function lengthPrefix(value) {
  if (value.length > 0xffffffff) throw new Error("Canonical transcript field is too large");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

export function encodeHandshakeTranscript(fields) {
  if (!Array.isArray(fields) || fields.some((field) => !Array.isArray(field) || field.length !== 2)) {
    throw new TypeError("Handshake fields must be ordered [name, value] pairs");
  }
  const names = new Set();
  const encoded = [lengthPrefix(Buffer.from(HANDSHAKE_DOMAIN, "utf8"))];
  for (const [rawName, rawValue] of fields) {
    const name = String(rawName);
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`Invalid handshake field name: ${name}`);
    if (names.has(name)) throw new Error(`Duplicate handshake field: ${name}`);
    names.add(name);
    encoded.push(lengthPrefix(Buffer.from(name, "utf8")), lengthPrefix(asBytes(rawValue, name)));
  }
  return Buffer.concat(encoded);
}

export function transcriptHash(transcript) {
  return createHash("sha256").update(asBytes(transcript, "transcript")).digest();
}

function exportKey(key, type) {
  return key.export({ format: "der", type });
}

export function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    algorithm: "Ed25519",
    publicKey: exportKey(publicKey, "spki").toString("base64"),
    privateKey: exportKey(privateKey, "pkcs8").toString("base64"),
    createdAt: new Date().toISOString()
  };
}

export function identityPublicKey(identity) {
  return createPublicKey({ key: Buffer.from(identity.publicKey, "base64"), format: "der", type: "spki" });
}

export function identityPrivateKey(identity) {
  return createPrivateKey({ key: Buffer.from(identity.privateKey, "base64"), format: "der", type: "pkcs8" });
}

export function identityFingerprint(identityOrPublicKey) {
  const key = typeof identityOrPublicKey === "object" && identityOrPublicKey.publicKey
    ? Buffer.from(identityOrPublicKey.publicKey, "base64")
    : exportKey(identityOrPublicKey, "spki");
  return createHash("sha256").update(key).digest("base64url");
}

export async function loadOrCreateIdentity(file) {
  const existing = await readSecureJson(file, null);
  if (existing) {
    if (existing.algorithm !== "Ed25519" || !existing.publicKey || !existing.privateKey) {
      throw new Error("Stored peer identity is invalid");
    }
    const publicKey = identityPublicKey(existing);
    const privateKey = identityPrivateKey(existing);
    const challenge = Buffer.from("arisa-identity-validation", "utf8");
    const signature = sign(null, challenge, privateKey);
    if (!verify(null, challenge, publicKey, signature)) throw new Error("Stored peer identity keypair does not match");
    return existing;
  }
  const identity = generateIdentity();
  await writeSecureJson(file, identity);
  return identity;
}

export function signHandshake(identity, transcript) {
  return sign(null, asBytes(transcript, "transcript"), identityPrivateKey(identity));
}

export function verifyHandshake(publicKeyDer, transcript, signature) {
  const publicKey = createPublicKey({ key: asBytes(publicKeyDer, "publicKey"), format: "der", type: "spki" });
  return verify(null, asBytes(transcript, "transcript"), publicKey, asBytes(signature, "signature"));
}

export function generateEphemeralKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey,
    privateKey,
    publicKeyBytes: exportKey(publicKey, "spki")
  };
}

function assertSecret(secret) {
  const value = typeof secret === "string" && secret.startsWith(BOOTSTRAP_SECRET_PREFIX)
    ? decodeBootstrapSecret(secret)
    : asBytes(secret, "connectionSecret");
  if (value.length !== 32) throw new Error("Connection secret must contain exactly 256 bits");
  return value;
}

export function proveConnectionSecret(secret, transcript) {
  const value = assertSecret(secret);
  return createHmac("sha256", value).update(HANDSHAKE_DOMAIN).update(transcriptHash(transcript)).digest();
}

export function verifyConnectionSecretProof(secret, transcript, proof) {
  const expected = proveConnectionSecret(secret, transcript);
  const received = asBytes(proof, "proof");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function deriveSessionKeys({
  localPrivateKey,
  remotePublicKeyBytes,
  connectionSecret,
  transcript,
  role,
  localIdentityPublicKeyBytes,
  remoteIdentityPublicKeyBytes
}) {
  if (!new Set(["master", "slave"]).has(role)) throw new Error("Session role must be master or slave");
  const remotePublicKey = createPublicKey({
    key: asBytes(remotePublicKeyBytes, "remotePublicKeyBytes"),
    format: "der",
    type: "spki"
  });
  const sharedSecret = diffieHellman({ privateKey: localPrivateKey, publicKey: remotePublicKey });
  const transcriptDigest = transcriptHash(transcript);
  const saltHash = createHash("sha256").update(HANDSHAKE_DOMAIN);
  if (connectionSecret == null) {
    saltHash.update("reconnect");
    if (localIdentityPublicKeyBytes != null || remoteIdentityPublicKeyBytes != null) {
      if (localIdentityPublicKeyBytes == null || remoteIdentityPublicKeyBytes == null) {
        throw new Error("Reconnect key derivation requires both peer identity public keys");
      }
      const identities = [
        asBytes(localIdentityPublicKeyBytes, "localIdentityPublicKeyBytes"),
        asBytes(remoteIdentityPublicKeyBytes, "remoteIdentityPublicKeyBytes")
      ].sort(Buffer.compare);
      saltHash.update(identities[0]).update(identities[1]);
    }
    saltHash.update(transcriptDigest);
  } else {
    saltHash.update("initial-pairing").update(assertSecret(connectionSecret));
  }
  const salt = saltHash.digest();
  const material = Buffer.from(hkdfSync("sha256", sharedSecret, salt, transcriptDigest, 72));
  const masterToSlave = {
    key: material.subarray(0, 32),
    nonceSalt: material.subarray(64, 68)
  };
  const slaveToMaster = {
    key: material.subarray(32, 64),
    nonceSalt: material.subarray(68, 72)
  };
  return role === "master"
    ? { send: masterToSlave, receive: slaveToMaster, transcriptHash: transcriptDigest }
    : { send: slaveToMaster, receive: masterToSlave, transcriptHash: transcriptDigest };
}
