import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const homeDir = await mkdtemp(path.join(os.tmpdir(), "arisa-tool-registry-home-"));
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;

const { ToolRegistry, createToolOutputParser } = await import("../src/core/tools/tool-registry.js");
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

async function createStreamingTool(name = "stream-tool") {
  const dir = await createFakeTool(name, { version: "2.1.0", packageDigest: "sha256:test", requirements: { ffmpeg: {} } });
  await writeFile(path.join(dir, "index.js"), `const frames = [
  { version: 1, jobId: "stream-job", type: "accepted", sequence: 1, payload: {} },
  { version: 1, jobId: "stream-job", type: "progress", sequence: 2, payload: { percent: 50 } },
  { version: 1, jobId: "stream-job", type: "chunk", sequence: 3, payload: { text: "part" } },
  { version: 1, jobId: "stream-job", type: "completed", sequence: 4, payload: { result: { ok: true, output: { text: "stream completed" } } } }
];
process.stderr.write("stream diagnostic\\n");
for (const frame of frames) {
  const line = JSON.stringify(frame) + "\\n";
  const midpoint = Math.floor(line.length / 2);
  process.stdout.write(line.slice(0, midpoint));
  await new Promise((resolve) => setTimeout(resolve, 2));
  process.stdout.write(line.slice(midpoint));
}
`, "utf8");
  return dir;
}

async function createHangingTool(name = "hanging-tool") {
  const dir = await createFakeTool(name);
  await writeFile(path.join(dir, "index.js"), `
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
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
    version: null,
    packageDigest: null,
    requirements: [],
    toolDependencies: {},
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

test("keeps the previous complete snapshot visible while a reload is in progress", async () => {
  const registry = new ToolRegistry();
  const previous = { name: "stable-tool" };
  const replacement = { name: "replacement-tool" };
  registry.tools = new Map([[previous.name, previous]]);

  let releaseSnapshot;
  registry.buildSnapshot = () => new Promise((resolve) => {
    releaseSnapshot = () => resolve(new Map([[replacement.name, replacement]]));
  });

  const loading = registry.load();
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    assert.equal(registry.get(previous.name), previous);
  }
  releaseSnapshot();
  await loading;

  assert.equal(registry.get(previous.name), null);
  assert.equal(registry.get(replacement.name), replacement);
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

test("reports dependency status in help and blocks a tool with a missing dependency", async () => {
  await resetHome();
  await createFakeTool("dependent-tool", {
    version: "1.0.0",
    toolDependencies: { "base-tool": "^1.0.0" }
  });

  const registry = new ToolRegistry();
  await registry.load();

  assert.match(await registry.help("dependent-tool"), /base-tool@\^1\.0\.0: missing/);
  await assert.rejects(
    () => registry.run({ name: "dependent-tool", request: { args: {} } }),
    /Tool dependency missing/
  );
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
  assert.deepEqual(await registry.usage("chat-1"), [{ name: "fake-tool", count: 1, official: false }]);

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

test("terminates timed-out tool runs and requires a status check before retry", async () => {
  await resetHome();
  await createHangingTool();
  const registry = new ToolRegistry({ runTimeoutMs: 20, killGraceMs: 20 });
  await registry.load();

  const result = await registry.run({
    name: "hanging-tool",
    chatId: "chat-1",
    request: { args: {} }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "outcome_uncertain");
  assert.equal(result.resolution.type, "status_check_required");
  assert.equal(result.resolution.retry, false);
  assert.match(result.error, /timed out after 20ms/);
});

test("terminates timed-out tool help processes", async () => {
  await resetHome();
  await createHangingTool();
  const registry = new ToolRegistry({ helpTimeoutMs: 20, killGraceMs: 20 });
  await registry.load();

  await assert.rejects(
    () => registry.help("hanging-tool"),
    /Tool help for hanging-tool timed out after 20ms/
  );
});

test("parses fragmented NDJSON incrementally and keeps stderr diagnostic-only", async () => {
  await resetHome();
  await createStreamingTool();
  const logs = [];
  const registry = new ToolRegistry({ logger: { log: (...args) => logs.push(args.join(" ")) } });
  await registry.load();
  const events = [];

  const result = await registry.run({
    name: "stream-tool",
    chatId: "chat-1",
    request: { text: "hello" },
    onEvent: (event) => events.push(event)
  });

  assert.equal(result.ok, true);
  assert.equal(result.output.text, "stream completed");
  assert.deepEqual(events.map((event) => event.type), ["accepted", "progress", "chunk", "completed"]);
  assert.match(logs.join("\n"), /stream diagnostic/);
  assert.doesNotMatch(JSON.stringify(events), /stream diagnostic/);
});

test("rejects invalid NDJSON sequences and a second terminal event", async () => {
  const invalidSequence = createToolOutputParser("sequence-tool");
  await invalidSequence.push(`${JSON.stringify({ version: 1, jobId: "job", type: "accepted", sequence: 1, payload: {} })}\n`);
  await assert.rejects(
    () => invalidSequence.push(`${JSON.stringify({ version: 1, jobId: "job", type: "chunk", sequence: 3, payload: {} })}\n`),
    /Invalid tool event sequence/
  );

  const duplicateTerminal = createToolOutputParser("terminal-tool");
  await duplicateTerminal.push(`${JSON.stringify({ version: 1, jobId: "job", type: "completed", sequence: 1, payload: { result: { ok: true } } })}\n`);
  await assert.rejects(
    () => duplicateTerminal.push(`${JSON.stringify({ version: 1, jobId: "job", type: "failed", sequence: 2, payload: { error: "late" } })}\n`),
    /more than one terminal event/
  );
});

test("preserves pretty-printed single JSON tool responses", async () => {
  const parser = createToolOutputParser("legacy-tool");
  const output = JSON.stringify({ ok: true, output: { text: "legacy" } }, null, 2);
  await parser.push(output.slice(0, 11));
  await parser.push(output.slice(11));
  assert.deepEqual(await parser.finish(), { mode: "legacy", output });
});
