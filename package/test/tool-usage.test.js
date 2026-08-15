import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolRegistry } from "../src/core/tools/tool-registry.js";
import { ToolUsageStore } from "../src/core/tools/tool-usage-store.js";
import { formatToolUsageReport } from "../src/runtime/tool-usage-report.js";

test("counts concurrent tool uses per chat", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-tool-usage-"));
  const store = new ToolUsageStore({ resolveFile: (chatId) => path.join(root, String(chatId), "usage.json") });
  try {
    await Promise.all([
      store.record("chat-1", "gmail-workspace"),
      store.record("chat-1", "gmail-workspace"),
      store.record("chat-1", "x-reader"),
      store.record("chat-2", "gmail-workspace")
    ]);
    assert.deepEqual(await store.counts("chat-1"), {
      "gmail-workspace": 2,
      "x-reader": 1
    });
    assert.deepEqual(await store.counts("chat-2"), { "gmail-workspace": 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports recorded usage for local tools not present in the startup registry", async () => {
  const registry = new ToolRegistry({
    usageStore: {
      counts: async () => ({ "creator-scout": 4 })
    },
    resolveOfficialToolNames: async () => new Set(["gmail-workspace"])
  });
  registry.tools.set("gmail-workspace", {
    name: "gmail-workspace",
    input: ["application/json"],
    output: ["application/json"]
  });

  assert.deepEqual(await registry.usage("chat-1"), [
    { name: "creator-scout", count: 4, official: false },
    { name: "gmail-workspace", count: 0, official: true }
  ]);
});

test("formats narrow tool usage counts with bullets and right-aligned numbers", () => {
  const report = formatToolUsageReport([
    { name: "gmail-workspace", count: 3, official: true },
    { name: "campaign-draft-runner", count: 12, official: false }
  ]);
  assert.match(report, /Official\n- gmail-workspace/);
  assert.match(report, /Local\n- campaign-draft-runner/);
  assert.match(report, /- campaign-draft-runner  12/);
  assert.match(report, /- gmail-workspace\s+3/);
  const rows = report.split("\n").filter((line) => line.startsWith("- "));
  assert.match(rows[0], /gmail-workspace/);
  assert.match(rows[1], /campaign-draft-runner/);
  assert.deepEqual(rows.map((line) => line.match(/\d+$/).index + line.match(/\d+$/)[0].length), [27, 27]);
  assert.deepEqual(rows.map((line) => line.length), [27, 27]);
  assert.ok(report.split("\n").every((line) => [...line].length <= 35));
});
