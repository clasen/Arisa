import assert from "node:assert/strict";
import test from "node:test";
import { EncryptedFrameDecoder, encryptFrame } from "../lib/encrypted-frames.js";

const key = Buffer.alloc(32, 0x11);
const nonceSalt = Buffer.from([1, 2, 3, 4]);
const options = { key, nonceSalt, maxFrameBytes: 1024 };

test("decodes fragmented and multiple encrypted frames in sequence", () => {
  const first = encryptFrame({ ...options, sequence: 1n, type: 4, payload: Buffer.from("first") });
  const second = encryptFrame({ ...options, sequence: 2n, type: 5, payload: Buffer.from("second") });
  const decoder = new EncryptedFrameDecoder(options);
  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(first.subarray(3, 11)), []);
  const frames = decoder.push(Buffer.concat([first.subarray(11), second]));
  assert.deepEqual(frames.map((frame) => [frame.type, frame.sequence, frame.payload.toString()]), [
    [4, 1n, "first"],
    [5, 2n, "second"]
  ]);
});

test("rejects replay, reorder, corruption, incompatible versions, and oversized lengths", () => {
  const first = encryptFrame({ ...options, sequence: 1n, type: 4, payload: Buffer.from("first") });
  const second = encryptFrame({ ...options, sequence: 2n, type: 4, payload: Buffer.from("second") });
  const replay = new EncryptedFrameDecoder(options);
  replay.push(first);
  assert.throws(() => replay.push(first), /replayed/);

  assert.throws(() => new EncryptedFrameDecoder(options).push(second), /Out-of-order/);
  const corrupt = Buffer.from(first);
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => new EncryptedFrameDecoder(options).push(corrupt), /authentication failed/);
  const wrongVersion = Buffer.from(first);
  wrongVersion[4] = 2;
  assert.throws(() => new EncryptedFrameDecoder(options).push(wrongVersion), /Unsupported protocol version/);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(1025);
  assert.throws(() => new EncryptedFrameDecoder(options).push(oversized), /maximum size/);
});

test("a protocol failure closes the decoder", () => {
  const decoder = new EncryptedFrameDecoder(options);
  const malformed = Buffer.alloc(4);
  malformed.writeUInt32BE(1);
  assert.throws(() => decoder.push(malformed), /protocol minimum/);
  assert.throws(() => decoder.push(Buffer.alloc(0)), /closed/);
});
