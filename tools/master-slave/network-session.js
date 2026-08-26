import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import {
  deriveSessionKeys,
  encodeHandshakeTranscript,
  generateEphemeralKeyPair,
  identityFingerprint,
  proveConnectionSecret,
  signHandshake,
  transcriptHash,
  verifyConnectionSecretProof,
  verifyHandshake
} from "./lib/handshake-crypto.js";
import { decryptFrame, encryptFrame, PROTOCOL_VERSION } from "./lib/encrypted-frames.js";

export const HANDSHAKE_FRAME_BYTES = 65_536;
export const TCP_KEEPALIVE_INITIAL_DELAY_MS = 15_000;

export function configureTransportSocket(socket) {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
  return socket;
}

export const MESSAGE_TYPES = Object.freeze({
  PAIR_CONFIRM: 1,
  PAIR_ACK: 2,
  HEARTBEAT: 10,
  PROFILE: 11,
  JOB_REQUEST: 20,
  JOB_CANCEL: 21,
  JOB_EVENT: 30,
  REVOKE: 40
});

function bytes(value, name) {
  try {
    return Buffer.from(String(value || ""), "base64");
  } catch {
    throw new Error(`Invalid base64 ${name}`);
  }
}

function fixedBytes(value, length, name) {
  const decoded = bytes(value, name);
  if (decoded.length !== length) throw new Error(`${name} must contain ${length} bytes`);
  return decoded;
}

function sameBytes(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireHello(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`Handshake ${field} is required`);
  return text;
}

function clientFields(hello) {
  return [
    ["protocol", Buffer.from([PROTOCOL_VERSION])],
    ["mode", requireHello(hello.mode, "mode")],
    ["slave_id", requireHello(hello.slaveId, "slaveId")],
    ["secret_id", hello.mode === "pair" ? requireHello(hello.secretId, "secretId") : ""],
    ["slave_identity", bytes(hello.identityPublicKey, "slave identity")],
    ["slave_ephemeral", bytes(hello.ephemeralPublicKey, "slave ephemeral key")],
    ["slave_challenge", fixedBytes(hello.challenge, 32, "slave challenge")]
  ];
}

function fullFields(hello, response) {
  return [
    ...clientFields(hello),
    ["master_identity", bytes(response.identityPublicKey, "master identity")],
    ["master_ephemeral", bytes(response.ephemeralPublicKey, "master ephemeral key")],
    ["master_challenge", fixedBytes(response.challenge, 32, "master challenge")]
  ];
}

async function writeSocket(socket, payload) {
  if (socket.write(payload)) return;
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      socket.off("drain", onDrain);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onClose = () => finish(new Error("Socket closed while applying backpressure"));
    const onError = (error) => finish(error);
    socket.once("drain", onDrain);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

class SocketReader {
  #buffer = Buffer.alloc(0);
  #waiters = [];
  #error = null;

  constructor(socket) {
    socket.on("data", (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
      this.#flush();
    });
    socket.once("error", (error) => this.#fail(error));
    socket.once("close", () => this.#fail(new Error("Socket closed before the protocol completed")));
  }

  #fail(error) {
    this.#error ||= error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#error);
  }

  #flush() {
    while (this.#waiters.length && this.#buffer.length >= this.#waiters[0].length) {
      const waiter = this.#waiters.shift();
      const result = this.#buffer.subarray(0, waiter.length);
      this.#buffer = this.#buffer.subarray(waiter.length);
      waiter.resolve(result);
    }
  }

  read(length) {
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error("Socket read length must be positive");
    if (this.#error) return Promise.reject(this.#error);
    if (this.#buffer.length >= length) {
      const result = this.#buffer.subarray(0, length);
      this.#buffer = this.#buffer.subarray(length);
      return Promise.resolve(result);
    }
    return new Promise((resolve, reject) => this.#waiters.push({ length, resolve, reject }));
  }
}

async function writePlain(socket, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > HANDSHAKE_FRAME_BYTES) throw new Error("Handshake frame exceeds the configured maximum size");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  await writeSocket(socket, Buffer.concat([header, body]));
}

async function readPlain(reader) {
  const header = await reader.read(4);
  const length = header.readUInt32BE(0);
  if (!length || length > HANDSHAKE_FRAME_BYTES) throw new Error("Invalid handshake frame length");
  const body = await reader.read(length);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Invalid handshake JSON");
  }
}

export class EncryptedConnection extends EventEmitter {
  #sendSequence = 1n;
  #receiveSequence = 1n;
  #reading = false;

  constructor({ socket, reader, send, receive, maxFrameBytes }) {
    super();
    this.socket = socket;
    this.reader = reader;
    this.sendKey = send.key;
    this.sendNonceSalt = send.nonceSalt;
    this.receiveKey = receive.key;
    this.receiveNonceSalt = receive.nonceSalt;
    this.maxFrameBytes = maxFrameBytes;
  }

  async send(type, payload) {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8");
    const frame = encryptFrame({
      key: this.sendKey,
      nonceSalt: this.sendNonceSalt,
      sequence: this.#sendSequence,
      type,
      payload: encoded,
      maxFrameBytes: this.maxFrameBytes
    });
    this.#sendSequence += 1n;
    await writeSocket(this.socket, frame);
  }

  async receive() {
    const header = await this.reader.read(4);
    const length = header.readUInt32BE(0);
    if (length > this.maxFrameBytes) throw new Error("Frame exceeds the configured maximum size");
    const body = await this.reader.read(length);
    const frame = decryptFrame(Buffer.concat([header, body]), {
      key: this.receiveKey,
      nonceSalt: this.receiveNonceSalt,
      expectedSequence: this.#receiveSequence,
      maxFrameBytes: this.maxFrameBytes
    });
    this.#receiveSequence += 1n;
    try {
      return { ...frame, payload: JSON.parse(frame.payload.toString("utf8")) };
    } catch {
      throw new Error("Encrypted message payload is not valid UTF-8 JSON");
    }
  }

  start() {
    if (this.#reading) return;
    this.#reading = true;
    (async () => {
      while (!this.socket.destroyed) {
        const message = await this.receive();
        this.emit("message", message);
      }
    })().catch((error) => {
      this.socket.destroy();
      this.emit("protocolError", error);
    });
  }

  close() {
    this.socket.destroy();
  }
}

function createClientHello({ mode, slaveId, secretId = "", identity, ephemeral, challenge, secret }) {
  const unsigned = {
    protocolVersion: PROTOCOL_VERSION,
    mode,
    slaveId,
    secretId,
    identityPublicKey: identity.publicKey,
    ephemeralPublicKey: ephemeral.publicKeyBytes.toString("base64"),
    challenge: challenge.toString("base64")
  };
  const transcript = encodeHandshakeTranscript(clientFields(unsigned));
  return {
    ...unsigned,
    signature: signHandshake(identity, transcript).toString("base64"),
    ...(mode === "pair" ? { secretProof: proveConnectionSecret(secret, transcript).toString("base64") } : {})
  };
}

function validateClientHello(hello, { peer, secret }) {
  if (hello.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported protocol version: ${hello.protocolVersion}`);
  if (!new Set(["pair", "reconnect"]).has(hello.mode)) throw new Error(`Unsupported handshake mode: ${hello.mode}`);
  const transcript = encodeHandshakeTranscript(clientFields(hello));
  const identityKey = bytes(hello.identityPublicKey, "slave identity");
  if (!verifyHandshake(identityKey, transcript, bytes(hello.signature, "slave signature"))) {
    throw new Error("Slave handshake signature is invalid");
  }
  if (hello.mode === "pair" && !verifyConnectionSecretProof(secret, transcript, bytes(hello.secretProof, "secret proof"))) {
    throw new Error("Slave connection-secret proof is invalid");
  }
  if (hello.mode === "reconnect") {
    if (!peer) throw new Error("Unknown Slave identity");
    if (!sameBytes(identityKey, Buffer.from(peer.identityPublicKey, "base64"))) throw new Error("Slave identity fingerprint changed");
  }
  return transcript;
}

export async function acceptMasterHandshake(socket, {
  identity,
  pairing,
  resolvePeer,
  persistPeer,
  maxFrameBytes
}) {
  configureTransportSocket(socket);
  const reader = new SocketReader(socket);
  const hello = await readPlain(reader);
  const peer = hello.mode === "reconnect" ? await resolvePeer(hello.slaveId) : null;
  const claim = hello.mode === "pair" ? await pairing.claim(hello.secretId) : null;
  try {
    validateClientHello(hello, { peer, secret: claim?.secret });
    const ephemeral = generateEphemeralKeyPair();
    const response = {
      protocolVersion: PROTOCOL_VERSION,
      identityPublicKey: identity.publicKey,
      ephemeralPublicKey: ephemeral.publicKeyBytes.toString("base64"),
      challenge: crypto.randomBytes(32).toString("base64")
    };
    const transcript = encodeHandshakeTranscript(fullFields(hello, response));
    response.signature = signHandshake(identity, transcript).toString("base64");
    if (claim) response.secretProof = proveConnectionSecret(claim.secret, transcript).toString("base64");
    await writePlain(socket, response);
    const keys = deriveSessionKeys({
      localPrivateKey: ephemeral.privateKey,
      remotePublicKeyBytes: bytes(hello.ephemeralPublicKey, "slave ephemeral key"),
      connectionSecret: claim?.secret,
      transcript,
      role: "master",
      localIdentityPublicKeyBytes: Buffer.from(identity.publicKey, "base64"),
      remoteIdentityPublicKeyBytes: bytes(hello.identityPublicKey, "slave identity")
    });
    const connection = new EncryptedConnection({ socket, reader, ...keys, maxFrameBytes });
    const confirmation = await connection.receive();
    if (confirmation.type !== MESSAGE_TYPES.PAIR_CONFIRM) throw new Error("Expected encrypted pairing confirmation");
    if (confirmation.payload.transcriptHash !== transcriptHash(transcript).toString("base64")) {
      throw new Error("Pairing transcript confirmation does not match");
    }
    const record = await persistPeer({
      slaveId: hello.slaveId,
      identityPublicKey: hello.identityPublicKey,
      identityFingerprint: identityFingerprint({ publicKey: hello.identityPublicKey }),
      authorizedChatIds: claim ? [claim.chatId] : peer.authorizedChatIds,
      profile: confirmation.payload.profile,
      connectedAt: new Date().toISOString()
    });
    if (claim) {
      if (claim.consume) await claim.consume();
      else await pairing.consumeClaim(claim.secretId, claim.claimToken);
    }
    await connection.send(MESSAGE_TYPES.PAIR_ACK, {
      slaveId: hello.slaveId,
      masterFingerprint: identityFingerprint(identity),
      authorizedChatIds: record.authorizedChatIds
    });
    return { connection, peer: record, paired: Boolean(claim) };
  } catch (error) {
    if (claim?.release) await claim.release().catch(() => {});
    else if (claim?.claimToken) await pairing.releaseClaim(claim.secretId, claim.claimToken).catch(() => {});
    socket.destroy();
    throw error;
  }
}

async function connectSlaveHandshakeInternal(socket, {
  identity,
  slaveId,
  profile,
  secret = null,
  secretId = "",
  expectedMasterPublicKey = null,
  maxFrameBytes
}) {
  configureTransportSocket(socket);
  const reader = new SocketReader(socket);
  const mode = secret ? "pair" : "reconnect";
  const ephemeral = generateEphemeralKeyPair();
  const hello = createClientHello({
    mode,
    slaveId,
    secretId,
    identity,
    ephemeral,
    challenge: crypto.randomBytes(32),
    secret
  });
  await writePlain(socket, hello);
  const response = await readPlain(reader);
  if (response.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported protocol version: ${response.protocolVersion}`);
  const masterIdentity = bytes(response.identityPublicKey, "master identity");
  if (expectedMasterPublicKey && !sameBytes(masterIdentity, Buffer.from(expectedMasterPublicKey, "base64"))) {
    throw new Error("Master identity fingerprint changed");
  }
  const transcript = encodeHandshakeTranscript(fullFields(hello, response));
  if (!verifyHandshake(masterIdentity, transcript, bytes(response.signature, "master signature"))) {
    throw new Error("Master handshake signature is invalid");
  }
  if (secret && !verifyConnectionSecretProof(secret, transcript, bytes(response.secretProof, "secret proof"))) {
    throw new Error("Master connection-secret proof is invalid");
  }
  const keys = deriveSessionKeys({
    localPrivateKey: ephemeral.privateKey,
    remotePublicKeyBytes: bytes(response.ephemeralPublicKey, "master ephemeral key"),
    connectionSecret: secret || undefined,
    transcript,
    role: "slave",
    localIdentityPublicKeyBytes: Buffer.from(identity.publicKey, "base64"),
    remoteIdentityPublicKeyBytes: masterIdentity
  });
  const connection = new EncryptedConnection({ socket, reader, ...keys, maxFrameBytes });
  await connection.send(MESSAGE_TYPES.PAIR_CONFIRM, {
    transcriptHash: transcriptHash(transcript).toString("base64"),
    profile
  });
  const acknowledgement = await connection.receive();
  if (acknowledgement.type !== MESSAGE_TYPES.PAIR_ACK || acknowledgement.payload.slaveId !== slaveId) {
    throw new Error("Master pairing acknowledgement is invalid");
  }
  return {
    connection,
    master: {
      identityPublicKey: response.identityPublicKey,
      fingerprint: identityFingerprint({ publicKey: response.identityPublicKey })
    },
    acknowledgement: acknowledgement.payload,
    paired: Boolean(secret)
  };
}

export async function connectSlaveHandshake(socket, options) {
  try {
    return await connectSlaveHandshakeInternal(socket, options);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
