import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function manifest(name) {
  return JSON.parse(await readFile(new URL(`../../tools/${name}/tool.manifest.json`, import.meta.url), "utf8"));
}

test("official orchestrators declare their hard tool dependencies", async () => {
  assert.deepEqual((await manifest("magnific-mcp")).toolDependencies, { "mcp-client": "^0.1.0" });
  assert.deepEqual((await manifest("campaign-draft-runner")).toolDependencies, {
    "pr-campaign": "^0.1.0",
    "gmail-workspace": "^0.1.0"
  });
  assert.deepEqual((await manifest("x-campaign-runner")).toolDependencies, { "x-dm": "^0.2.0" });
  assert.deepEqual((await manifest("x-dm")).toolDependencies, { "browser-session-bridge": "^0.1.0" });
  assert.deepEqual((await manifest("official-tool-sync")).toolDependencies, { trash: "^1.0.0" });
});

test("optional tool integrations do not become hard dependencies", async () => {
  assert.deepEqual((await manifest("whatsapp-web")).toolDependencies, undefined);
  assert.deepEqual((await manifest("pr-campaign")).toolDependencies, undefined);
  assert.deepEqual((await manifest("master-slave")).toolDependencies, undefined);
});
