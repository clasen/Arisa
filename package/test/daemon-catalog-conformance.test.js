import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const expected = {
  "whispermix-transcribe": { scope: "global", autoStart: false },
  "whatsapp-web": { scope: "chat", autoStart: false },
  "roster-sites": { scope: "global", autoStart: true },
  "turn-server": { scope: "global", autoStart: true },
  "signaling-server": { scope: "global", autoStart: true }
};

for (const [toolName, daemon] of Object.entries(expected)) {
  test(`${toolName} declares the managed daemon contract`, async () => {
    const toolDir = path.join(repositoryRoot, "tools", toolName);
    const manifest = JSON.parse(await readFile(path.join(toolDir, "tool.manifest.json"), "utf8"));
    const source = await readFile(path.join(toolDir, manifest.entry), "utf8");

    assert.equal(manifest.daemon.scope, daemon.scope);
    assert.equal(manifest.daemon.autoStart, daemon.autoStart);
    assert.equal(manifest.daemon.health, "internal");
    assert.match(source, /createDaemonRuntime/);
    assert.match(source, /healthCheck/);
  });
}
