import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncPrimeAuth } from "../src/core/agent/prime-auth.js";

test("copies compatible Pi credentials to Prime auth with private permissions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "arisa-prime-auth-"));
  const sourceFile = path.join(dir, "pi-auth.json");
  const targetFile = path.join(dir, "prime", "auth.json");
  await writeFile(sourceFile, JSON.stringify({
    codex: { type: "oauth", access: "token" },
    ignored: { type: "custom", secret: "no" }
  }));

  const result = await syncPrimeAuth({
    provider: "openai",
    apiKey: "test-key",
    sourceFile,
    targetFile
  });
  const auth = JSON.parse(await readFile(targetFile, "utf8"));
  assert.deepEqual(result.providers.sort(), ["codex", "openai"]);
  assert.equal(auth.codex.type, "oauth");
  assert.deepEqual(auth.openai, { type: "api_key", key: "test-key" });
  assert.equal(auth.ignored, undefined);
  if (process.platform !== "win32") {
    assert.equal((await stat(targetFile)).mode & 0o777, 0o600);
  }
});

test("preserves a newer credential written by Prime login", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "arisa-prime-auth-newer-"));
  const sourceFile = path.join(dir, "pi-auth.json");
  const targetFile = path.join(dir, "prime", "auth.json");
  await writeFile(sourceFile, JSON.stringify({ codex: { type: "oauth", access: "old-pi-token" } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await syncPrimeAuth({ sourceFile, targetFile });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await writeFile(targetFile, JSON.stringify({ codex: { type: "oauth", access: "new-prime-token" } }));
  await syncPrimeAuth({ sourceFile, targetFile });
  const auth = JSON.parse(await readFile(targetFile, "utf8"));
  assert.equal(auth.codex.access, "new-prime-token");
});
