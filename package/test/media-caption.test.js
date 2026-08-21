import assert from "node:assert/strict";
import test from "node:test";
import { resolveMediaCaption } from "../src/core/capabilities/capability-service.js";

test("does not turn a domain-like filename into a caption", () => {
  assert.equal(resolveMediaCaption(undefined), undefined);
});

test("keeps an explicit caption that is not a local path", () => {
  assert.equal(resolveMediaCaption("Here is the report"), "Here is the report");
});

test("drops an explicit caption that leaks an absolute path", () => {
  assert.equal(resolveMediaCaption("/Users/me/.arisa/artifacts/report.md"), undefined);
});
