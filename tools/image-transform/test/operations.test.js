import test from "node:test";
import assert from "node:assert/strict";
import { compileOperations, parseOperations } from "../operations.js";

test("parses and compiles an ordered image pipeline", () => {
  const operations = parseOperations('[{"type":"crop","zoom":2,"focusX":0.55,"focusY":0.08},{"type":"resize","width":512,"height":512,"fit":"cover"},{"type":"format","format":"webp","quality":85}]');
  const plan = compileOperations(operations);
  assert.equal(plan.format, "webp");
  assert.equal(plan.quality, 85);
  assert.deepEqual(plan.filters, [
    "crop=min(iw\\,ih)/2:min(iw\\,ih)/2:(iw-min(iw\\,ih)/2)*0.55:(ih-min(iw\\,ih)/2)*0.08",
    "scale=512:512:force_original_aspect_ratio=increase",
    "crop=512:512"
  ]);
});

test("supports visual adjustment operations", () => {
  assert.deepEqual(compileOperations([{ type: "flip", axis: "horizontal" }, { type: "adjust", brightness: 0.1, contrast: 1.2, saturation: 0.8 }, { type: "grayscale" }]).filters, [
    "hflip",
    "eq=brightness=0.1:contrast=1.2:saturation=0.8",
    "format=gray"
  ]);
});

test("rejects arbitrary filters and invalid bounds", () => {
  assert.throws(() => compileOperations([{ type: "shell", command: "x" }]), /Unsupported image operation/);
  assert.throws(() => compileOperations([{ type: "blur", sigma: 101 }]), /blur sigma/);
});
