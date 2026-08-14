import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, formatUpdateReport, installCoreUpdate, updateOfficialTools } from "../src/runtime/update-manager.js";

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

test("installs only the currently published core update and verifies it", async () => {
  const calls = [];
  const versions = ["5.0.2", "5.1.0"];
  const result = await installCoreUpdate({ targetVersion: "5.1.0" }, {
    readVersion: async () => versions.shift(),
    fetchVersion: async () => "5.1.0",
    execute: async (...args) => { calls.push(args); }
  });

  assert.deepEqual(calls, [["npm", ["install", "--global", "arisa@5.1.0"]]]);
  assert.deepEqual(result, {
    updated: true,
    previousVersion: "5.0.2",
    currentVersion: "5.1.0"
  });
});

test("refuses a stale core update button", async () => {
  await assert.rejects(
    installCoreUpdate({ targetVersion: "5.1.0" }, {
      readVersion: async () => "5.0.2",
      fetchVersion: async () => "5.1.1",
      execute: async () => assert.fail("must not install a stale target")
    }),
    /Run \/update again/
  );
});

test("updates only safe official tools and reloads the registry", async () => {
  const calls = [];
  const toolRegistry = {
    async run(request) {
      calls.push(request);
      return {
        ok: true,
        output: {
          json: {
            updates: [{ name: "context-vault", action: "updated" }],
            skipped: [{ name: "customized", status: "locally-modified" }]
          }
        }
      };
    },
    async load() { calls.push("load"); }
  };

  assert.deepEqual(await updateOfficialTools({ chatId: 42, toolRegistry }), {
    updated: ["context-vault"],
    skipped: [{ name: "customized", status: "locally-modified" }]
  });
  assert.deepEqual(calls, [
    { name: "official-tool-sync", chatId: 42, request: { args: { action: "update-safe" } } },
    "load"
  ]);
});
