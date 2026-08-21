import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cacheBudgetBytes, chromiumCacheArgs, chromiumCacheUsage, pruneChromiumCaches } from "../browser-cache.js";

async function sparseFile(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "");
  await truncate(file, bytes);
}

test("prunes only discardable Chromium caches above the budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-browser-cache-"));
  try {
    await sparseFile(path.join(root, "Default", "Cache", "data"), 12 * 1024 * 1024);
    await sparseFile(path.join(root, "Default", "Code Cache", "code"), 8 * 1024 * 1024);
    await mkdir(path.join(root, "Default", "IndexedDB"), { recursive: true });
    await writeFile(path.join(root, "Default", "IndexedDB", "session"), "keep");
    await writeFile(path.join(root, "Default", "Cookies"), "keep-cookie");

    const before = await chromiumCacheUsage(root);
    assert.equal(before.bytes, 20 * 1024 * 1024);
    const result = await pruneChromiumCaches(root, cacheBudgetBytes("16"));

    assert.equal(result.afterBytes, 8 * 1024 * 1024);
    assert.deepEqual(result.removed, [path.join("Default", "Cache")]);
    assert.equal(await readFile(path.join(root, "Default", "IndexedDB", "session"), "utf8"), "keep");
    assert.equal(await readFile(path.join(root, "Default", "Cookies"), "utf8"), "keep-cookie");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignores symlinked cache contents and bounds Chromium launch flags", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-browser-cache-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "arisa-browser-cache-outside-"));
  try {
    await sparseFile(path.join(outside, "secret"), 24 * 1024 * 1024);
    await mkdir(path.join(root, "Default"), { recursive: true });
    await symlink(outside, path.join(root, "Default", "Cache"));
    assert.equal((await chromiumCacheUsage(root)).bytes, 0);
    assert.deepEqual(chromiumCacheArgs(cacheBudgetBytes("32")), [
      "--disk-cache-size=16777216",
      "--media-cache-size=8388608"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
