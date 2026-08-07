import assert from "node:assert/strict";
import test from "node:test";
import { prepareAgentRuntime } from "../src/runtime/create-app.js";

test("prepares the pinned managed runtime for an active Prime configuration", async () => {
  const config = {
    agent: { runtime: "prime" },
    prime: { command: "", version: "0.7.0", provider: "test", model: "model" }
  };
  let received;
  const prepared = await prepareAgentRuntime(config, {
    resolvePrimeImpl: async (options) => {
      received = options;
      return {
        command: process.execPath,
        commandArgs: ["/managed/prime-agent/cli.js"],
        managed: true,
        runtimeDir: "/managed/prime-agent/0.7.0",
        kernelVenvDir: "/managed/prime-kernel"
      };
    }
  });

  assert.equal(received.command, "");
  assert.equal(received.version, "0.7.0");
  assert.equal(prepared.prime.command, process.execPath);
  assert.deepEqual(prepared.prime.commandArgs, ["/managed/prime-agent/cli.js"]);
  assert.equal(prepared.prime.managedRuntime, true);
  assert.equal(prepared.prime.kernelVenvDir, "/managed/prime-kernel");
  assert.equal(config.prime.command, "");
});

test("does not prepare Prime while the rollback Pi runtime is active", async () => {
  const config = {
    agent: { runtime: "pi" },
    pi: { provider: "test", model: "model" },
    prime: { command: "", version: "0.7.0" }
  };
  const prepared = await prepareAgentRuntime(config, {
    resolvePrimeImpl: async () => { throw new Error("must not resolve Prime"); }
  });

  assert.equal(prepared, config);
});
