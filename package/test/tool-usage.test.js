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

test("caps shared column widths when a four-digit count makes the report too wide", () => {
  const report = formatToolUsageReport([
    { name: "gmail-workspace", count: 6970, official: true },
    { name: "a".repeat(28), count: 1, official: false }
  ]);
  assert.match(report, /Official\n- gmail-workspace\s+6970/);
  assert.ok(report.split("\n").every((line) => [...line].length <= 35));
  const row = report.split("\n").find((line) => line.startsWith("- gmail-workspace"));
  assert.equal(row.length, 35);
  assert.match(report, new RegExp(`Local\\n- ${"a".repeat(27)}\\n  a\\s+1`));
});

for (const { name, count } of [
  { name: "n".repeat(27), count: 6970 },
  { name: "n".repeat(28), count: 6970 },
  { name: "long-tool-".repeat(12), count: 1234567 },
  { name: "long-tool-".repeat(12), count: Number.MAX_SAFE_INTEGER },
  { name: "long-tool-".repeat(12), count: "9".repeat(31) },
  { name: "long-tool-".repeat(12), count: "9".repeat(70) },
  { name: "工具😀".repeat(20), count: 6970 }
]) {
  test(`preserves all name and count characters within 35 columns (${[...name].length}/${String(count).length})`, () => {
    const report = formatToolUsageReport([{ name, count, official: true }]);
    const lines = report.split("\n");
    assert.ok(lines.every((line) => [...line].length <= 35));
    const fields = lines
      .filter((line) => (line.startsWith("- ") || line.startsWith("  ")) && line !== "  (none)")
      .map((line) => line.slice(2).replace(/\s+/g, ""))
      .join("");
    assert.equal(fields, name + count);
  });
}

test("keeps empty sections and descending usage order", () => {
  const empty = formatToolUsageReport([]);
  assert.match(empty, /Official\n  \(none\)\n\nLocal\n  \(none\)/);
  const report = formatToolUsageReport([
    { name: "z-low", count: 1, official: true },
    { name: "z-high", count: 200, official: true },
    { name: "a-high", count: 200, official: true }
  ]);
  const rows = report.split("\n").filter((line) => line.startsWith("- "));
  assert.match(rows[0], /^- a-high\s+200$/);
  assert.match(rows[1], /^- z-high\s+200$/);
  assert.match(rows[2], /^- z-low\s+1$/);
});
