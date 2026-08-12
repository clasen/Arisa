import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { changedPaths, classifyTool, scanTree, updatePlan } from "./sync-lib.js";

const file = (hash) => ({ type: "file", hash, mode: 420 });

test("classifies an upstream-only change as safely updateable", () => {
  const baseline = { "index.js": file("old") };
  const local = { "index.js": file("old") };
  const official = { "index.js": file("new") };
  const result = classifyTool({ localFiles: local, officialFiles: official, baselineFiles: baseline, baselineCommit: "a", remoteCommit: "b" });
  assert.equal(result.status, "update-available");
  assert.equal(result.safeToUpdate, true);
  assert.deepEqual(result.conflicts, []);
});

test("adopts a baseline when official files match and only local extras exist", () => {
  const local = { "index.js": file("same"), "package-lock.json": file("local") };
  const official = { "index.js": file("same") };
  const result = classifyTool({ localFiles: local, officialFiles: official, baselineFiles: null, baselineCommit: null, remoteCommit: "b" });
  assert.equal(result.status, "baseline-refresh");
  assert.equal(result.safeToUpdate, true);
  assert.deepEqual(result.localChanges, ["package-lock.json"]);
});

test("detects a true three-way conflict", () => {
  const baseline = { "index.js": file("old") };
  const local = { "index.js": file("local") };
  const official = { "index.js": file("remote") };
  const result = classifyTool({ localFiles: local, officialFiles: official, baselineFiles: baseline, baselineCommit: "a", remoteCommit: "b" });
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts, ["index.js"]);
});

test("preserves non-conflicting local files in the update plan", () => {
  const baseline = { "index.js": file("old") };
  const local = { "index.js": file("old"), "local.test.js": file("test") };
  const official = { "index.js": file("new") };
  const plan = updatePlan({ localFiles: local, officialFiles: official, baselineFiles: baseline });
  assert.deepEqual(plan.apply, ["index.js"]);
  assert.deepEqual(plan.preserve, ["local.test.js"]);
  assert.deepEqual(plan.conflicts, []);
});

test("scan excludes config, git metadata, and dependencies", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "official-sync-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "index.js"), "export {};\n");
  await writeFile(path.join(root, "config.js"), "secret\n");
  await writeFile(path.join(root, ".git", "HEAD"), "main\n");
  await writeFile(path.join(root, "node_modules", "dep.js"), "dep\n");
  const files = await scanTree(root, { protectedFiles: ["config.js"] });
  assert.deepEqual(Object.keys(files), ["index.js"]);
  assert.deepEqual(changedPaths(files, files), []);
});
