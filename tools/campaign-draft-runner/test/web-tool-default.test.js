import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WEB_TOOL } from "../index.js";

test("uses Lightpanda as the default discovery and personalization web tool", () => {
  assert.equal(DEFAULT_WEB_TOOL, "lightpanda-browser");
});
