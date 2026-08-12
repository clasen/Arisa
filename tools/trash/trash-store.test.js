import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listTrash,
  moveToTrash,
  purgeTrashItem,
  restoreFromTrash,
  trashStatus
} from "./trash-store.js";

const config = {
  retentionDays: 30,
  minimumFreeBytes: 1,
  maxFilesystemUsagePercent: 99,
  allowCrossFilesystemCopy: true,
  protectedPaths: []
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-trash-test-"));
  const stateRoot = path.join(root, "state");
  const sourceRoot = path.join(root, "source");
  await mkdir(sourceRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, stateRoot, sourceRoot };
}

test("moves and restores a directory without overwriting", async (t) => {
  const { stateRoot, sourceRoot } = await fixture(t);
  const source = path.join(sourceRoot, "project");
  await mkdir(source);
  await writeFile(path.join(source, "hello.txt"), "hello", "utf8");

  const moved = await moveToTrash({ sourcePath: source, stateRoot, config });
  assert.equal(moved.status, "trashed");
  assert.equal(moved.storageMethod, "rename");
  assert.equal(moved.bytes, 5);
  await assert.rejects(readFile(path.join(source, "hello.txt")), /ENOENT/);

  const restored = await restoreFromTrash({ id: moved.id, stateRoot, config });
  assert.equal(restored.status, "restored");
  assert.equal(await readFile(path.join(source, "hello.txt"), "utf8"), "hello");

  const listed = await listTrash({ stateRoot });
  assert.equal(listed.items[0].status, "restored");
});

test("purge requires an exact id confirmation and reclaims payload", async (t) => {
  const { stateRoot, sourceRoot } = await fixture(t);
  const source = path.join(sourceRoot, "large.tmp");
  await writeFile(source, "123456", "utf8");
  const moved = await moveToTrash({ sourcePath: source, stateRoot, config });

  await assert.rejects(
    purgeTrashItem({ id: moved.id, confirmation: "yes", stateRoot }),
    /exactly match/
  );
  const purged = await purgeTrashItem({ id: moved.id, confirmation: moved.id, stateRoot });
  assert.equal(purged.status, "purged");
  assert.equal(purged.reclaimedBytes, 6);
});

test("status reports retained bytes and filesystem capacity", async (t) => {
  const { stateRoot, sourceRoot } = await fixture(t);
  const source = path.join(sourceRoot, "data.bin");
  await writeFile(source, "1234", "utf8");
  await moveToTrash({ sourcePath: source, stateRoot, config });
  const status = await trashStatus({ stateRoot, config });
  assert.equal(status.counts.trashed, 1);
  assert.equal(status.retainedBytes, 4);
  assert.ok(status.space.availableBytes > 0);
});
