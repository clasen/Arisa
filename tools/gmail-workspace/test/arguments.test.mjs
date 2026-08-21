import test from "node:test";
import assert from "node:assert/strict";
import { parseArgvArgument, parseListArgument } from "../arguments.js";

test("list arguments accept native arrays, JSON arrays, and comma-separated strings", () => {
  assert.deepEqual(parseListArgument(["a", "b"]), ["a", "b"]);
  assert.deepEqual(parseListArgument('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseListArgument("a, b"), ["a", "b"]);
});

test("argv accepts native and JSON-encoded arrays without splitting embedded JSON", () => {
  const argv = ["gmail", "users", "threads", "get", "--params", '{"id":"a,b"}'];
  assert.deepEqual(parseArgvArgument(argv), argv);
  assert.deepEqual(parseArgvArgument(JSON.stringify(argv)), argv);
});

test("argv rejects commands outside Gmail", () => {
  assert.throws(() => parseArgvArgument('["drive","files","list"]'), /starting with "gmail"/);
});
