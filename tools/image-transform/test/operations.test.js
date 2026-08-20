import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import sharp from "sharp";
import { compileOperations, parseOperations } from "../operations.js";
import { runSharp } from "../sharp-runner.js";

test("compiles direct Sharp methods in order", () => {
  const operations = parseOperations('[{"method":"resize","args":[{"width":512,"height":512,"fit":"cover"}]},{"method":"modulate","options":{"saturation":0.8}},{"method":"webp","options":{"quality":85}}]');
  assert.deepEqual(compileOperations(operations), {
    pipeline: [
      { method: "resize", args: [{ width: 512, height: 512, fit: "cover" }] },
      { method: "modulate", args: [{ saturation: 0.8 }] },
      { method: "webp", args: [{ quality: 85 }] }
    ],
    format: "webp"
  });
});

test("keeps legacy operations compatible", () => {
  const plan = compileOperations([
    { type: "crop", zoom: 2, focusX: 0.55, focusY: 0.08 },
    { type: "resize", width: 512, height: 512, fit: "cover" },
    { type: "format", format: "webp", quality: 85 }
  ]);
  assert.equal(plan.format, "webp");
  assert.equal(plan.pipeline[0].method, "$focalCrop");
  assert.deepEqual(plan.pipeline[1], { method: "resize", args: [{ width: 512, height: 512, fit: "cover", background: "black" }] });
});

test("adds a default jpeg output operation", () => {
  assert.deepEqual(compileOperations([{ method: "grayscale" }]), {
    pipeline: [{ method: "grayscale", args: [] }, { method: "jpeg", args: [{ quality: 90 }] }],
    format: "jpeg"
  });
});

test("rejects unsupported methods, local paths, and excessive dimensions", () => {
  assert.throws(() => compileOperations([{ method: "toFile", args: ["/tmp/escape"] }]), /Unsupported Sharp method/);
  assert.throws(() => compileOperations([{ method: "composite", args: [[{ input: "/etc/passwd" }]] }]), /Unsupported Sharp method/);
  assert.throws(() => compileOperations([{ method: "resize", options: { width: 20000 } }]), /cannot exceed/);
});

test("runs a real Sharp pipeline", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "image-transform-test-"));
  try {
    const sourcePath = path.join(directory, "source.png");
    const outputPath = path.join(directory, "output.webp");
    await sharp({ create: { width: 40, height: 20, channels: 4, background: "red" } }).png().toFile(sourcePath);
    const plan = compileOperations([{ method: "resize", options: { width: 10 } }, { method: "webp", options: { quality: 80 } }]);
    const info = await runSharp({ sourcePath, outputPath, pipeline: plan.pipeline });
    assert.equal(info.width, 10);
    assert.equal(info.height, 5);
    assert.equal(info.format, "webp");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
