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
      official: [
        { name: "context-vault", status: "up-to-date" },
        { name: "customized", status: "diverged" },
        { name: "gmail-workspace", status: "upstream-update" }
      ],
      nonOfficial: ["private-helper"],
      counts: { "up-to-date": 1, "upstream-update": 1, diverged: 1 },
      updateable: ["context-vault"],
      blocked: [{ name: "customized", status: "diverged" }]
    }
  }), [
    "```text",
    "Arisa update",
    "============",
    "Core",
    "  Current    5.0.2",
    "  Latest     5.1.0",
    "  Status     update available",
    "",
    "Official tools",
    "  Installed  3",
    "  up-to-date           1",
    "  upstream-update      1",
    "  diverged             1",
    "",
    "Official (3)",
    "  - context-vault",
    "  - customized [diverged]",
    "  - gmail-workspace",
    "    [upstream-update]",
    "",
    "Non-official (1)",
    "  - private-helper",
    "",
    "Safe updates",
    "  - context-vault",
    "",
    "Needs review",
    "  - customized",
    "    [diverged]",
    "",
    "Update support installed",
    "  - official-tool-sync",
    "```"
  ].join("\n"));
});

test("shortens long review status labels", () => {
  const report = formatUpdateReport({
    core: { currentVersion: "5.0.2", latestVersion: "5.0.2", updateAvailable: false },
    bootstrapInstalled: [],
    tools: {
      installedOfficial: 2,
      official: [
        { name: "audio-extractor", status: "locally-modified" },
        { name: "campaign-draft-runner", status: "untracked-difference" }
      ],
      nonOfficial: [],
      counts: {},
      updateable: [],
      blocked: [
        { name: "audio-extractor", status: "locally-modified" },
        { name: "campaign-draft-runner", status: "untracked-difference" }
      ]
    }
  });
  assert.match(report, /audio-extractor\n    \[local\]/);
  assert.match(report, /campaign-draft-runner\n    \[untracked\]/);
  assert.ok(report.split("\n").every((line) => [...line].length <= 35));
});
