import { createCipheriv, createDecipheriv } from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const FRAME_HEADER_BYTES = 14;
export const AUTH_TAG_BYTES = 16;
export const MIN_FRAME_LENGTH = FRAME_HEADER_BYTES - 4 + AUTH_TAG_BYTES;

function assertSequence(sequence) {
  const value = typeof sequence === "bigint" ? sequence : BigInt(sequence);
  if (value < 1n || value > 0xffffffffffffffffn) throw new Error("Frame sequence is out of range");
  return value;
}

function assertKey(key) {
  const value = Buffer.from(key);
  if (value.length !== 32) throw new Error("AES-256-GCM key must be 32 bytes");
  return value;
}

function nonceFor(nonceSalt, sequence) {
  const salt = Buffer.from(nonceSalt);
  if (salt.length !== 4) throw new Error("Directional nonce salt must be 4 bytes");
  const nonce = Buffer.alloc(12);
  salt.copy(nonce, 0);
  nonce.writeBigUInt64BE(sequence, 4);
  return nonce;
}

function authenticatedHeader(version, type, sequence) {
  if (!Number.isInteger(version) || version < 0 || version > 255) throw new Error("Protocol version is invalid");
  if (!Number.isInteger(type) || type < 0 || type > 255) throw new Error("Frame message type is invalid");
  const header = Buffer.alloc(10);
  header.writeUInt8(version, 0);
  header.writeUInt8(type, 1);
  header.writeBigUInt64BE(sequence, 2);
  return header;
}

export function encryptFrame({ key, nonceSalt, sequence, type, payload, version = PROTOCOL_VERSION, maxFrameBytes }) {
  const orderedSequence = assertSequence(sequence);
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const aad = authenticatedHeader(version, type, orderedSequence);
  const cipher = createCipheriv("aes-256-gcm", assertKey(key), nonceFor(nonceSalt, orderedSequence));
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const bodyLength = aad.length + ciphertext.length + AUTH_TAG_BYTES;
  if (bodyLength > 0xffffffff || (maxFrameBytes != null && bodyLength > maxFrameBytes)) {
    throw new Error("Frame exceeds the configured maximum size");
  }
  const frame = Buffer.alloc(4 + bodyLength);
  frame.writeUInt32BE(bodyLength, 0);
  aad.copy(frame, 4);
  ciphertext.copy(frame, FRAME_HEADER_BYTES);
  cipher.getAuthTag().copy(frame, FRAME_HEADER_BYTES + ciphertext.length);
  return frame;
}

export function decryptFrame(frame, { key, nonceSalt, expectedSequence, expectedVersion = PROTOCOL_VERSION, maxFrameBytes }) {
  const bytes = Buffer.from(frame);
  if (bytes.length < 4 + MIN_FRAME_LENGTH) throw new Error("Encrypted frame is truncated");
  const bodyLength = bytes.readUInt32BE(0);
  if (bodyLength !== bytes.length - 4) throw new Error("Encrypted frame length mismatch");
  if (maxFrameBytes != null && bodyLength > maxFrameBytes) throw new Error("Frame exceeds the configured maximum size");
  const version = bytes.readUInt8(4);
  if (version !== expectedVersion) throw new Error(`Unsupported protocol version: ${version}`);
  const type = bytes.readUInt8(5);
  const sequence = bytes.readBigUInt64BE(6);
  const orderedSequence = assertSequence(expectedSequence);
  if (sequence !== orderedSequence) {
    throw new Error(sequence < orderedSequence ? "Repeated or replayed frame sequence" : "Out-of-order frame sequence");
  }
  const aad = bytes.subarray(4, FRAME_HEADER_BYTES);
  const ciphertext = bytes.subarray(FRAME_HEADER_BYTES, bytes.length - AUTH_TAG_BYTES);
  const tag = bytes.subarray(bytes.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", assertKey(key), nonceFor(nonceSalt, sequence));
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return {
      version,
      type,
      sequence,
      payload: Buffer.concat([decipher.update(ciphertext), decipher.final()])
    };
  } catch {
    throw new Error("Encrypted frame authentication failed");
  }
}

export class EncryptedFrameDecoder {
  #buffer = Buffer.alloc(0);
  #failed = false;
  #expectedSequence;

  constructor({ key, nonceSalt, expectedSequence = 1n, expectedVersion = PROTOCOL_VERSION, maxFrameBytes }) {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < MIN_FRAME_LENGTH) {
      throw new Error("maxFrameBytes must be an integer large enough for an encrypted frame");
    }
    this.key = assertKey(key);
    this.nonceSalt = Buffer.from(nonceSalt);
    this.expectedVersion = expectedVersion;
    this.maxFrameBytes = maxFrameBytes;
    this.#expectedSequence = assertSequence(expectedSequence);
  }

  push(chunk) {
    if (this.#failed) throw new Error("Encrypted frame decoder is closed after a protocol error");
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const frames = [];
    try {
      while (this.#buffer.length >= 4) {
        const bodyLength = this.#buffer.readUInt32BE(0);
        if (bodyLength < MIN_FRAME_LENGTH) throw new Error("Encrypted frame length is below the protocol minimum");
        if (bodyLength > this.maxFrameBytes) throw new Error("Frame exceeds the configured maximum size");
        const totalLength = bodyLength + 4;
        if (this.#buffer.length < totalLength) break;
        const encoded = this.#buffer.subarray(0, totalLength);
        this.#buffer = this.#buffer.subarray(totalLength);
        const frame = decryptFrame(encoded, {
          key: this.key,
          nonceSalt: this.nonceSalt,
          expectedSequence: this.#expectedSequence,
          expectedVersion: this.expectedVersion,
          maxFrameBytes: this.maxFrameBytes
        });
        frames.push(frame);
        this.#expectedSequence += 1n;
      }
      return frames;
    } catch (error) {
      this.#failed = true;
      this.#buffer = Buffer.alloc(0);
      throw error;
    }
  }

  get expectedSequence() {
    return this.#expectedSequence;
  }
}
