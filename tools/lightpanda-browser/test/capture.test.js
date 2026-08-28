import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { decodeBoundedPng, writeCapture } from "../capture.js";

function png(width = 800, height = 600, extraBytes = 0) {
  const buffer = Buffer.alloc(24 + extraBytes);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function result(buffer, mimeType = "image/png") {
  return { content: [{ type: "image", mimeType, data: buffer.toString("base64") }] };
}

test("decodes bounded inline PNG dimensions and bytes", () => {
  const decoded = decodeBoundedPng(result(png(1024, 768)), {
    CAPTURE_MAX_BYTES: 16 * 1024,
    CAPTURE_MAX_WIDTH: 1280,
    CAPTURE_MAX_HEIGHT: 4096
  });
  assert.equal(decoded.width, 1024);
  assert.equal(decoded.height, 768);
  assert.equal(decoded.bytes, 24);
  assert.equal(decoded.mimeType, "image/png");
});

test("rejects oversized, over-dimensional, and non-PNG captures", () => {
  assert.throws(() => decodeBoundedPng(result(png(800, 600, 20 * 1024)), { CAPTURE_MAX_BYTES: 16 * 1024 }), /exceeds 16384 bytes/);
  assert.throws(() => decodeBoundedPng(result(png(1281, 600)), { CAPTURE_MAX_WIDTH: 1280 }), /dimensions/);
  assert.throws(() => decodeBoundedPng(result(Buffer.alloc(24))), /not a valid PNG/);
  assert.throws(() => decodeBoundedPng(result(png(), "image/jpeg")), /unsupported type/);
});

test("writes a private temporary PNG for artifact materialization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lp-capture-test-"));
  try {
    const capture = await writeCapture(result(png(800, 600)), { tmpDir: root, config: {} });
    assert.equal(capture.fileName.endsWith(".png"), true);
    assert.equal((await readFile(capture.filePath)).equals(png(800, 600)), true);
    assert.equal(capture.width, 800);
    assert.equal(capture.height, 600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
