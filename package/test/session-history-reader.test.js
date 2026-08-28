import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectSessionForPreloadMigration } from "../src/core/agent/session-history-reader.js";

function writeSession(entries) {
  const dir = mkdtempSync(path.join(tmpdir(), "arisa-session-reader-"));
  const file = path.join(dir, "session.jsonl");
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return { dir, file };
}

const header = {
  type: "session",
  version: 3,
  id: "session-id",
  timestamp: "2026-08-28T00:00:00.000Z",
  cwd: "/workspace"
};

function message(id, parentId, text) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-28T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] }
  };
}

test("discovers the latest valid compaction on the active branch without retaining divergent payloads", () => {
  const entries = [
    header,
    message("kept", null, "kept context"),
    {
      type: "compaction",
      id: "active-compaction",
      parentId: "kept",
      firstKeptEntryId: "kept",
      summary: "active summary"
    },
    message("after", "active-compaction", "recent context"),
    {
      type: "compaction",
      id: "divergent-compaction",
      parentId: "kept",
      firstKeptEntryId: "kept",
      summary: "divergent summary"
    },
    message("leaf", "after", "active leaf")
  ];
  const { dir, file } = writeSession(entries);
  try {
    const result = inspectSessionForPreloadMigration(file, 1);
    assert.equal(result.compactionId, "active-compaction");
    assert.equal(result.summary, "active summary");
    assert.deepEqual(result.contextEntries.map((entry) => entry.id), ["kept", "after", "leaf"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not migrate a small, unsupported, or structurally invalid session", () => {
  const cases = [
    [header, message("one", null, "small")],
    [{ ...header, version: 2 }, message("kept", null, "old"), {
      type: "compaction", id: "comp", parentId: "kept", firstKeptEntryId: "kept", summary: "summary"
    }],
    [header, message("leaf", "missing-parent", "broken"), {
      type: "compaction", id: "comp", parentId: "leaf", firstKeptEntryId: "leaf", summary: "summary"
    }]
  ];
  for (const entries of cases) {
    const { dir, file } = writeSession(entries);
    try {
      const threshold = entries === cases[0] ? 1024 * 1024 : 1;
      assert.equal(inspectSessionForPreloadMigration(file, threshold), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
