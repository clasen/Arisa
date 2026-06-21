import assert from "node:assert/strict";
import test from "node:test";
import { parseProcessIds } from "../src/runtime/process-ids.js";

test("ignores empty PID command output", () => {
  assert.deepEqual(parseProcessIds(""), []);
  assert.deepEqual(parseProcessIds("   \n\t"), []);
});

test("parses only positive integer PID tokens", () => {
  assert.deepEqual(parseProcessIds("123\n456"), [123, 456]);
  assert.deepEqual(parseProcessIds("11970/tcp: 1234"), [1234]);
  assert.deepEqual(parseProcessIds("0 nope -12 42"), [42]);
});
