import assert from "node:assert/strict";
import test from "node:test";
import { prepareConfigForSave } from "../src/core/config/config-store.js";
import { applyConfigDefaults, defaultPrimeVersion } from "../src/core/config/config-defaults.js";
import { prepareAgentRuntime } from "../src/runtime/create-app.js";

test("keeps managed Prime on Arisa's current default without pinning it in config", () => {
  const managed = applyConfigDefaults({
    agent: { runtime: "prime" },
    prime: { command: "", version: "0.7.0" }
  });

  assert.equal(defaultPrimeVersion, "0.7.1");
  assert.equal(managed.prime.version, defaultPrimeVersion);
  assert.equal("version" in prepareConfigForSave(managed).prime, false);

  const external = applyConfigDefaults({
    agent: { runtime: "prime" },
    prime: { command: "/opt/prime/bin/prime-agent", version: "0.7.0" }
  });
  assert.equal(external.prime.version, "0.7.0");
  assert.equal(prepareConfigForSave(external).prime.version, "0.7.0");
});

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

test("drops inactive managed runtime process details so Prime can be resolved again", async () => {
  const config = {
    agent: { runtime: "pi" },
    pi: { provider: "test", model: "model" },
    prime: {
      command: process.execPath,
      commandArgs: ["/managed/prime-agent/cli.js"],
      managedRuntime: true,
      runtimeDir: "/managed/prime-agent/0.7.0",
      kernelVenvDir: "/managed/prime-kernel",
      version: "0.7.0"
    }
  };
  const prepared = await prepareAgentRuntime(config, {
    resolvePrimeImpl: async () => { throw new Error("must not resolve inactive Prime"); }
  });

  assert.equal(prepared.prime.command, "");
  assert.equal("commandArgs" in prepared.prime, false);
  assert.equal("managedRuntime" in prepared.prime, false);
  assert.equal("runtimeDir" in prepared.prime, false);
  assert.equal("kernelVenvDir" in prepared.prime, false);
});

test("re-resolves a live managed Prime command instead of treating Node as external Prime", async () => {
  const config = {
    agent: { runtime: "prime" },
    prime: {
      command: process.execPath,
      commandArgs: ["/old/managed/prime-agent/cli.js"],
      managedRuntime: true,
      version: "0.7.0"
    }
  };
  let receivedCommand;
  const prepared = await prepareAgentRuntime(config, {
    resolvePrimeImpl: async ({ command }) => {
      receivedCommand = command;
      return {
        command: process.execPath,
        commandArgs: ["/current/managed/prime-agent/cli.js"],
        managed: true,
        runtimeDir: "/current/managed/prime-agent/0.7.0",
        kernelVenvDir: "/managed/prime-kernel"
      };
    }
  });

  assert.equal(receivedCommand, "");
  assert.deepEqual(prepared.prime.commandArgs, ["/current/managed/prime-agent/cli.js"]);
});

test("does not persist managed Prime process details", () => {
  const persisted = prepareConfigForSave({
    agent: { runtime: "prime" },
    prime: {
      command: process.execPath,
      commandArgs: ["/managed/prime-agent/cli.js"],
      managedRuntime: true,
      runtimeDir: "/managed/prime-agent/0.7.0",
      kernelVenvDir: "/managed/prime-kernel",
      version: "0.7.0"
    }
  });

  assert.equal(persisted.prime.command, "");
  assert.equal("commandArgs" in persisted.prime, false);
  assert.equal("managedRuntime" in persisted.prime, false);
  assert.equal("runtimeDir" in persisted.prime, false);
  assert.equal("kernelVenvDir" in persisted.prime, false);
});
