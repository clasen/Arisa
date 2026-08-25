import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRemoteCommandRequest, resolveCommandArgv, resolveCommandTimeout } from "../command-arguments.js";

test("parses string-safe argvJson into structured process arguments", () => {
  const request = normalizeRemoteCommandRequest({
    chatId: "123",
    args: {
      action: "run_slave_command",
      executable: "pm2",
      argvJson: '["logs","0","--nostream","--lines","120"]',
      timeoutMs: "30000"
    }
  });
  assert.deepEqual(request.args.argv, ["logs", "0", "--nostream", "--lines", "120"]);
  assert.equal("argvJson" in request.args, false);
  assert.equal(request.args.timeoutMs, 30_000);
});

test("keeps structured argv compatibility for direct CLI callers", () => {
  assert.deepEqual(resolveCommandArgv({ argv: ["status", "--json"] }), ["status", "--json"]);
});

test("rejects malformed or unsafe command arguments", () => {
  assert.throws(() => resolveCommandArgv({ argvJson: "not-json" }), /valid JSON/);
  assert.throws(() => resolveCommandArgv({ argvJson: '{"arg":"value"}' }), /must be an array/);
  assert.throws(() => resolveCommandArgv({ argvJson: '["ok",1]' }), /only strings/);
  assert.throws(() => resolveCommandArgv({ argv: ["ok"], argvJson: '["other"]' }), /either argv or argvJson/);
  assert.throws(() => resolveCommandArgv({ argvJson: '["bad\\u0000arg"]' }), /NUL bytes/);
});

test("normalizes string-safe command timeouts", () => {
  assert.equal(resolveCommandTimeout("30000"), 30_000);
  assert.equal(resolveCommandTimeout(undefined), undefined);
  assert.throws(() => resolveCommandTimeout("30.5"), /positive integer/);
  assert.throws(() => resolveCommandTimeout("0"), /positive integer/);
});

test("normalizes string-safe Slave policy fields", () => {
  const request = normalizeRemoteCommandRequest({
    args: {
      action: "configure_slave",
      rootsJson: '["/usr"]',
      capabilitiesJson: '["inspect","exec"]',
      fullHost: "false"
    }
  });
  assert.deepEqual(request.args.roots, ["/usr"]);
  assert.deepEqual(request.args.capabilities, ["inspect", "exec"]);
  assert.equal(request.args.fullHost, false);
  assert.equal("rootsJson" in request.args, false);
  assert.equal("capabilitiesJson" in request.args, false);

  const directStringFields = normalizeRemoteCommandRequest({
    args: {
      action: "configure_slave",
      roots: '["/srv"]',
      capabilities: '["inspect"]',
      fullHost: "false"
    }
  });
  assert.deepEqual(directStringFields.args.roots, ["/srv"]);
  assert.deepEqual(directStringFields.args.capabilities, ["inspect"]);
});

test("rejects malformed string-safe Slave policy fields", () => {
  assert.throws(() => normalizeRemoteCommandRequest({
    args: { action: "configure_slave", rootsJson: '{}', capabilitiesJson: '[]', fullHost: "false" }
  }), /roots must be an array of strings/);
  assert.throws(() => normalizeRemoteCommandRequest({
    args: { action: "configure_slave", rootsJson: '[]', capabilitiesJson: '[]', fullHost: "sometimes" }
  }), /fullHost must be true or false/);
});

test("does not rewrite unrelated requests", () => {
  const request = { args: { action: "list_slaves", argvJson: "ignored" } };
  assert.equal(normalizeRemoteCommandRequest(request), request);
});
