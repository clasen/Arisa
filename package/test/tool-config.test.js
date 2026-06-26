import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const homeDir = await mkdtemp(path.join(os.tmpdir(), "arisa-tool-config-home-"));
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;

const {
  loadToolConfig,
  parseConfigModule,
  serializeConfigModule,
  writeToolConfig
} = await import("../src/core/tools/tool-config.js");

test("parses and serializes config modules", () => {
  const config = parseConfigModule("export default {\n  apiKey: \"secret\",\n  enabled: true\n};\n");
  const serialized = serializeConfigModule(config);

  assert.deepEqual(config, { apiKey: "secret", enabled: true });
  assert.equal(serialized, "export default {\n  apiKey: \"secret\",\n  enabled: true\n};\n");
  assert.deepEqual(parseConfigModule(serialized), config);
});

test("loads tool config with defaults, global config, and chat config precedence", async () => {
  await writeToolConfig("demo-tool", {
    apiKey: "global-key",
    mode: "global",
    retries: 3
  });
  await writeToolConfig("demo-tool", {
    mode: "chat",
    chatOnly: true
  }, "chat-1");

  const config = await loadToolConfig("demo-tool", {
    apiKey: "default-key",
    mode: "default",
    timeoutMs: 1000
  }, "chat-1");

  assert.deepEqual(config, {
    apiKey: "global-key",
    mode: "chat",
    timeoutMs: 1000,
    retries: 3,
    chatOnly: true
  });
});

test("writes config modules to the selected scope", async () => {
  const { getChatToolConfigPath } = await import("../src/runtime/paths.js");
  const configPath = await writeToolConfig("scoped-tool", { token: "chat-token" }, "chat-2");
  const source = await readFile(configPath, "utf8");

  assert.equal(configPath, getChatToolConfigPath("chat-2", "scoped-tool"));
  assert.equal(source, "export default {\n  token: \"chat-token\"\n};\n");
});

test("documents that config parsing executes JavaScript expressions", () => {
  delete globalThis.__arisaConfigExecuted;

  const config = parseConfigModule(
    "export default (() => { globalThis.__arisaConfigExecuted = true; return { enabled: true }; })();"
  );

  assert.deepEqual(config, { enabled: true });
  assert.equal(globalThis.__arisaConfigExecuted, true);
  delete globalThis.__arisaConfigExecuted;
});
