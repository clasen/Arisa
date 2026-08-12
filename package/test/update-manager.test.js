import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, formatUpdateReport } from "../src/runtime/update-manager.js";

test("compares semantic versions", () => {
  assert.equal(compareVersions("5.0.2", "5.0.3"), -1);
  assert.equal(compareVersions("5.1.0", "5.0.9"), 1);
  assert.equal(compareVersions("5.0.2", "5.0.2"), 0);
  assert.equal(compareVersions("invalid", "5.0.2"), null);
});

test("formats core and official tool update status", () => {
  assert.equal(formatUpdateReport({
    core: { currentVersion: "5.0.2", latestVersion: "5.1.0", updateAvailable: true },
    bootstrapInstalled: ["official-tool-sync"],
    tools: {
      installedOfficial: 3,
      counts: { "up-to-date": 1, "upstream-update": 1, diverged: 1 },
      updateable: ["context-vault"],
      blocked: [{ name: "customized", status: "diverged" }]
    }
  }), [
    "```text",
    "Arisa update report",
    "├─ Core: 5.0.2 -> 5.1.0  update available",
    "└─ Official tools: 3 installed",
    "   ├─ up-to-date: 1",
    "   ├─ upstream-update: 1",
    "   ├─ diverged: 1",
    "   ├─ Safe updates",
    "   │  └─ context-vault",
    "   ├─ Needs review",
    "   │  └─ customized [diverged]",
    "   └─ Update support installed",
    "      └─ official-tool-sync",
    "```"
  ].join("\n"));
});
