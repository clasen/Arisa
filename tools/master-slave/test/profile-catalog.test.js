import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSafeSlaveProfile, buildSafeToolCatalog, digestToolPackage } from "../lib/profile-catalog.js";

test("publishes only allowlisted profile and tool metadata", () => {
  const tools = [{
    name: "example",
    version: "1.0.0",
    digest: "sha256:abc",
    description: "Example tool",
    category: "developer",
    keywords: ["example"],
    input: ["text/plain"],
    output: ["application/json"],
    configSchema: { TOKEN: { secret: true }, endpoint: { type: "string" } },
    config: { TOKEN: "private", endpoint: "https://private.invalid" },
    env: { PRIVATE: "no" },
    requirements: { filesystem: ["read"], network: ["outbound"], arbitrary: ["secret"] },
    daemon: { scope: "global", autoStart: true, runtime: { state: "ready", alive: true, message: "token=private", logFile: "/private" } }
  }];
  const profile = buildSafeSlaveProfile({
    slaveId: "slave-1",
    name: "api",
    description: "API host",
    hostname: "api-1",
    platform: "linux",
    arch: "arm64",
    arisaVersion: "5.1.7",
    masterEndpoint: "tcp://192.0.2.1:4719",
    privilege: { user: "arisa-slave", root: false, scope: "restricted" },
    roots: ["/srv/api"],
    capabilities: ["inspect", "tool.run"],
    environment: { SECRET: "no" }
  }, { tools });
  assert.deepEqual(profile.tools[0].configFields, ["TOKEN", "endpoint"]);
  assert.deepEqual(profile.tools[0].requirements, { filesystem: ["read"], network: ["outbound"] });
  const serialized = JSON.stringify(profile);
  for (const secret of ["private", "private.invalid", "token=", "logFile", "environment"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("tool package digest is deterministic and excludes config values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-slave-digest-"));
  await writeFile(path.join(root, "index.js"), "export {};\n");
  await writeFile(path.join(root, "config.js"), "export default { token: 'one' };\n");
  const first = await digestToolPackage(root);
  await writeFile(path.join(root, "config.js"), "export default { token: 'two' };\n");
  assert.equal(await digestToolPackage(root), first);
  await writeFile(path.join(root, "index.js"), "export const changed = true;\n");
  assert.notEqual(await digestToolPackage(root), first);
  assert.deepEqual(buildSafeToolCatalog([{ name: "z" }, { name: "a" }]).map((tool) => tool.name), ["a", "z"]);
});

test("bounds untrusted profile and catalog strings", () => {
  const oversized = "x".repeat(2_000);
  const profile = buildSafeSlaveProfile({
    slaveId: "slave-1",
    name: oversized,
    description: oversized,
    privilege: { user: oversized }
  }, {
    tools: [{
      name: "fixture",
      description: oversized,
      configSchema: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`field-${index}`, {}]))
    }]
  });
  assert.equal(profile.name.length, 128);
  assert.equal(profile.description.length, 512);
  assert.equal(profile.privilege.user.length, 128);
  assert.equal(profile.tools[0].description.length, 512);
  assert.equal(profile.tools[0].configFields.length, 256);
});
