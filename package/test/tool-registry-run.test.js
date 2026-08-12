import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const homeDir = await mkdtemp(path.join(os.tmpdir(), "arisa-tool-registry-home-"));
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;

const { ToolRegistry } = await import("../src/core/tools/tool-registry.js");
const {
  arisaHomeDir,
  arisaPackageDir,
  arisaIpcSocketFile,
  toolsDir
} = await import("../src/runtime/paths.js");

async function resetHome() {
  await rm(arisaHomeDir, { recursive: true, force: true });
}

async function createFakeTool(name = "fake-tool", manifestOverrides = {}) {
  const dir = path.join(toolsDir, name);
  await mkdir(dir, { recursive: true });
  const manifest = {
    name,
    description: "Fake test tool",
    entry: "index.js",
    input: ["text/plain"],
    output: ["text/plain"],
    configSchema: {
      apiKey: { type: "string", required: false }
    },
    skillHints: [{ name: "missing-skill", when: "testing" }]
  };
  await writeFile(path.join(dir, "tool.manifest.json"), `${JSON.stringify({
    ...manifest,
    ...manifestOverrides
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(dir, "config.js"), "export default {\n  apiKey: \"default-key\"\n};\n", "utf8");
  await writeFile(path.join(dir, "index.js"), `import { readFile } from "node:fs/promises";

const requestFileIndex = process.argv.indexOf("--request-file");
if (process.argv.includes("--help")) {
  process.stdout.write("Fake test tool help\\n");
  process.exit(0);
}
if (requestFileIndex === -1) {
  process.stdout.write(JSON.stringify({ ok: false, error: "missing request file" }));
  process.exit(0);
}

const requestFile = process.argv[requestFileIndex + 1];
const request = JSON.parse(await readFile(requestFile, "utf8"));
process.stdout.write(JSON.stringify({
  ok: true,
  output: {
    text: "tool completed",
    request,
    requestFile,
    env: {
      ARISA_PACKAGE_DIR: process.env.ARISA_PACKAGE_DIR,
      ARISA_IPC_SOCKET: process.env.ARISA_IPC_SOCKET
    }
  }
}));
`, "utf8");
  return dir;
}

test("loads and lists installed tools from the user tools directory", async () => {
  await resetHome();
  await createFakeTool("fake-tool", {
    category: "memory",
    keywords: ["memory", "essential"]
  });

  const registry = new ToolRegistry();
  await registry.load();

  assert.deepEqual(registry.list(), [{
    name: "fake-tool",
    description: "Fake test tool",
    input: ["text/plain"],
    output: ["text/plain"],
    configSchema: {
      apiKey: { type: "string", required: false }
    },
    category: "memory",
    keywords: ["memory", "essential"],
    skillHints: [{ name: "missing-skill", when: "testing" }]
  }]);
});

test("lists optional semantic metadata with stable defaults", async () => {
  await resetHome();
  await createFakeTool("fake-tool");

  const registry = new ToolRegistry();
  await registry.load();

  assert.equal(registry.list()[0].category, null);
  assert.deepEqual(registry.list()[0].keywords, []);
});

test("shows semantic metadata in tool help", async () => {
  await resetHome();
  await createFakeTool("fake-tool", {
    category: "memory",
    keywords: ["memory", "essential"]
  });

  const registry = new ToolRegistry();
  await registry.load();

  const help = await registry.help("fake-tool");

  assert.match(help, /Fake test tool help/);
  assert.match(help, /Semantic metadata:\n- category: memory\n- keywords: memory, essential/);
  assert.match(help, /Assigned skills:/);
});

test("runs a registered tool process with an enriched request and cleans up request files", async () => {
  await resetHome();
  await createFakeTool("fake-tool");

  const registry = new ToolRegistry();
  await registry.load();

  const result = await registry.run({
    name: "fake-tool",
    chatId: "chat-1",
    request: {
      text: "hello",
      args: { count: 2 }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.output.text, "tool completed");
  assert.deepEqual(result.output.request, {
    text: "hello",
    args: { count: 2 },
    chatId: "chat-1",
    skills: [{
      name: "missing-skill",
      when: "testing",
      found: false,
      description: "",
      path: "",
      content: ""
    }]
  });
  assert.equal(result.output.env.ARISA_PACKAGE_DIR, arisaPackageDir);
  assert.equal(result.output.env.ARISA_IPC_SOCKET, arisaIpcSocketFile);
  assert.deepEqual(await registry.usage("chat-1"), [{ name: "fake-tool", count: 1 }]);

  const requestFile = result.output.requestFile;
  await assert.rejects(() => access(requestFile), { code: "ENOENT" });
  await assert.rejects(() => access(path.dirname(requestFile)), { code: "ENOENT" });
});

test("keeps concurrent requests to the same tool isolated", async () => {
  await resetHome();
  await createFakeTool("fake-tool");

  const registry = new ToolRegistry();
  await registry.load();

  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => registry.run({
    name: "fake-tool",
    chatId: "chat-1",
    request: { text: `request-${index}`, args: { index } }
  })));

  assert.deepEqual(
    results.map((result) => result.output.request.text).sort(),
    Array.from({ length: 12 }, (_, index) => `request-${index}`).sort()
  );
  assert.equal(new Set(results.map((result) => result.output.requestFile)).size, 12);
});

test("rejects unknown tools", async () => {
  await resetHome();
  const registry = new ToolRegistry();
  await registry.load();

  await assert.rejects(
    () => registry.run({ name: "missing-tool", request: {}, chatId: "chat-1" }),
    /Tool not found: missing-tool/
  );
});
