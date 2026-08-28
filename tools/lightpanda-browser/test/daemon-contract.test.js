import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const toolDir = new URL("../", import.meta.url);

test("manifest declares the scoped managed daemon health contract", async () => {
  const manifest = JSON.parse(await readFile(new URL("tool.manifest.json", toolDir), "utf8"));
  assert.deepEqual(manifest.daemon, { scope: "chat", autoStart: true, health: "internal" });
  assert.equal(manifest.version, "0.10.1");
  assert.equal(manifest.configSchema.SESSION_TTL_MS.type, "number");
  assert.equal(manifest.configSchema.MAX_SESSIONS.type, "number");
  assert.equal(manifest.configSchema.IDLE_TIMEOUT_MS.type, "number");
});

test("daemon entry uses shared runtime with health, recovery, and shutdown cleanup", async () => {
  const source = await readFile(new URL("index.js", toolDir), "utf8");
  assert.match(source, /createDaemonRuntime/);
  assert.match(source, /healthCheck:/);
  assert.match(source, /recover:/);
  assert.match(source, /beforeExit:/);
  assert.doesNotMatch(source, /daemon\.pid|commands\/.*request/);
});
