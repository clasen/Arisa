import test from "node:test";
import assert from "node:assert/strict";
import { buildSquareZoomFilter, cropOptions } from "../crop.js";

test("normalizes square crop options", () => {
  assert.deepEqual(cropOptions({ zoom: "2", focusX: "0.55", focusY: "0.08", size: "512" }), {
    zoom: 2,
    focusX: 0.55,
    focusY: 0.08,
    size: 512,
    quality: 2
  });
});

test("builds a focal square zoom filter", () => {
  assert.equal(
    buildSquareZoomFilter(cropOptions({ zoom: 2, focusX: 0.55, focusY: 0.08 })),
    "crop=min(iw\\,ih)/2:min(iw\\,ih)/2:(iw-min(iw\\,ih)/2)*0.55:(ih-min(iw\\,ih)/2)*0.08,scale=1024:1024"
  );
});

test("rejects out-of-range options", () => {
  assert.throws(() => cropOptions({ zoom: 9 }), /zoom must be between 1 and 8/);
});
