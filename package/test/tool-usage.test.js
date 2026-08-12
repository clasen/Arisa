import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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

test("formats narrow tool usage counts", () => {
  const report = formatToolUsageReport([
    { name: "campaign-draft-runner", count: 12 },
    { name: "gmail-workspace", count: 3 }
  ]);
  assert.match(report, /campaign-draft-runner\s+12/);
  assert.match(report, /gmail-workspace\s+3/);
  assert.ok(report.split("\n").every((line) => [...line].length <= 35));
});
