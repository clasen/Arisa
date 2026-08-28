import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createPreloadMigrationChild,
  migrateRecentSessionBeforeLoad
} from "../src/core/agent/session-preload-migration.js";

function sourceMessage(id, parentId, role, text) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-28T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }] }
  };
}

function writeEntries(file, entries) {
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

test("atomically creates a valid child session with a durable parent reference", () => {
  const sessionDir = mkdtempSync(path.join(tmpdir(), "arisa-session-migration-"));
  try {
    const result = createPreloadMigrationChild({
      sessionDir,
      cwd: "/workspace",
      migration: {
        sourceFile: path.join(sessionDir, "historical.jsonl"),
        sourceBytes: 80 * 1024 * 1024,
        summary: "compacted history",
        contextEntries: [
          sourceMessage("old-user", null, "user", "recent question"),
          { type: "label", id: "ignored", parentId: "old-user", targetId: "old-user", label: "old" },
          sourceMessage("old-assistant", "old-user", "assistant", "recent answer")
        ]
      },
      operationalNotes: "Durable operating notes:\n- keep history",
      now: new Date("2026-08-28T12:00:00.000Z")
    });

    assert.equal(result.copiedEntries, 2);
    assert.equal(readdirSync(sessionDir).some((name) => name.endsWith(".tmp")), false);
    const entries = readFileSync(result.targetFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(entries[0].parentSession, result.sourceFile);
    assert.deepEqual(entries.slice(1).map((entry) => entry.parentId), [
      null,
      entries[1].id,
      entries[2].id,
      entries[3].id
    ]);
    assert.equal(entries[2].details.source, "preload-migration");

    const manager = SessionManager.open(result.targetFile, sessionDir, "/workspace");
    const messages = manager.buildSessionContext().messages;
    assert.deepEqual(messages.map((message) => message.role), ["custom", "custom", "user", "assistant"]);
    assert.match(messages[1].content, /compacted history/);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("pre-load migration commits once and a restart selects the compact child", () => {
  const sessionDir = mkdtempSync(path.join(tmpdir(), "arisa-session-recovery-"));
  const sourceFile = path.join(sessionDir, "historical.jsonl");
  try {
    writeEntries(sourceFile, [
      { type: "session", version: 3, id: "old", timestamp: "2026-08-28T00:00:00.000Z", cwd: "/workspace" },
      sourceMessage("historical", null, "user", "x".repeat(8_000)),
      sourceMessage("kept", "historical", "user", "recent"),
      {
        type: "compaction",
        id: "compaction",
        parentId: "kept",
        firstKeptEntryId: "kept",
        summary: "bounded summary"
      },
      sourceMessage("leaf", "compaction", "assistant", "answer")
    ]);

    const first = migrateRecentSessionBeforeLoad({
      sessionDir,
      cwd: "/workspace",
      policy: { maxPersistedBytes: 2_000 },
      operationalNotes: "notes"
    });
    assert.equal(first.sourceFile, sourceFile);
    assert.ok(first.targetBytes < 2_000);
    assert.equal(migrateRecentSessionBeforeLoad({
      sessionDir,
      cwd: "/workspace",
      policy: { maxPersistedBytes: 2_000 }
    }), null);
    const resumed = SessionManager.continueRecent("/workspace", sessionDir);
    assert.equal(resumed.getSessionFile(), first.targetFile);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("refuses to load an oversized session when no safe compaction checkpoint exists", () => {
  const sessionDir = mkdtempSync(path.join(tmpdir(), "arisa-session-refusal-"));
  try {
    writeEntries(path.join(sessionDir, "unsafe.jsonl"), [
      { type: "session", version: 3, id: "unsafe", timestamp: "2026-08-28T00:00:00.000Z", cwd: "/workspace" },
      sourceMessage("leaf", null, "user", "x".repeat(4_000))
    ]);
    assert.throws(() => migrateRecentSessionBeforeLoad({
      sessionDir,
      cwd: "/workspace",
      policy: { maxPersistedBytes: 1_000 }
    }), (error) => error.code === "PI_SESSION_PRELOAD_MIGRATION_UNAVAILABLE");
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});
