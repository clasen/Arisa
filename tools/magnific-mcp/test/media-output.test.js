import assert from "node:assert/strict";
import test from "node:test";
import { extension, mediaKind, outputMime } from "../media-output.js";

test("preserves supported Magnific media types and strips parameters", () => {
  assert.equal(outputMime({}, "audio/mpeg; charset=binary"), "audio/mpeg");
  assert.equal(outputMime({ mimeType: "video/mp4" }, "application/octet-stream"), "video/mp4");
  assert.equal(outputMime({ contentType: "audio/mp3" }), "audio/mpeg");
});

test("maps media types to safe file extensions and artifact kinds", () => {
  assert.equal(extension("audio/mpeg"), ".mp3");
  assert.equal(extension("video/webm"), ".webm");
  assert.equal(extension("application/octet-stream"), ".bin");
  assert.equal(mediaKind("audio/mpeg"), "audio");
  assert.equal(mediaKind("video/mp4"), "video");
  assert.equal(mediaKind("application/octet-stream"), "file");
});
