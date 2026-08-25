import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listSlavePath,
  readSlaveFile,
  resolveAllowedPath,
  SlaveProcessExecutor
} from "../slave-operations.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-slave-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "arisa-slave-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "inside.txt"), "inside", "utf8");
  await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
  return { root, outside };
}

test("contains reads within real allowed roots and rejects symlink escapes", async (t) => {
  const { root, outside } = await fixture(t);
  assert.equal(
    await resolveAllowedPath(path.join(root, "nested", "inside.txt"), [root]),
    await realpath(path.join(root, "nested", "inside.txt"))
  );
  await symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));
  await assert.rejects(
    () => readSlaveFile({ target: path.join(root, "escape.txt"), roots: [root], maxBytes: 1024 }),
    (error) => error.code === "PATH_NOT_ALLOWED"
  );
});

test("lists bounded metadata without following directory entries", async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(await listSlavePath({ target: path.join(root, "nested"), roots: [root], maxEntries: 10 }), [
    { name: "inside.txt", type: "file" }
  ]);
  await assert.rejects(
    () => listSlavePath({ target: root, roots: [root], maxEntries: 0 }),
    /positive integer/
  );
});

test("reads files only within the byte limit", async (t) => {
  const { root } = await fixture(t);
  const result = await readSlaveFile({ target: path.join(root, "nested", "inside.txt"), roots: [root], maxBytes: 6 });
  assert.equal(result.content.toString("utf8"), "inside");
  await assert.rejects(
    () => readSlaveFile({ target: path.join(root, "nested", "inside.txt"), roots: [root], maxBytes: 5 }),
    (error) => error.code === "OUTPUT_LIMIT_EXCEEDED"
  );
});

test("executes argv directly without a shell and streams bounded chunks", async (t) => {
  const { root } = await fixture(t);
  const chunks = [];
  const executor = new SlaveProcessExecutor({ roots: [root], maxOutputBytes: 1024, maxTimeoutMs: 5_000 });
  const result = await executor.execute({
    jobId: "job-1",
    executable: process.execPath,
    argv: ["--input-type=module", "--eval", "process.stdout.write(process.argv[1])", "$(not-a-shell)"],
    cwd: root,
    timeoutMs: 2_000
  }, { onChunk: (chunk) => chunks.push(chunk) });
  assert.equal(result.status, "completed");
  assert.equal(chunks.map((chunk) => chunk.data).join(""), "$(not-a-shell)");
  assert.deepEqual(chunks.map((chunk) => chunk.sequence), [1]);
});

test("defaults process cwd to the first allowed root", async (t) => {
  const { root } = await fixture(t);
  const executor = new SlaveProcessExecutor({ roots: [root], maxOutputBytes: 1024, maxTimeoutMs: 5_000 });
  const result = await executor.execute({
    jobId: "job-default-cwd",
    executable: process.execPath,
    argv: ["--input-type=module", "--eval", "process.stdout.write(process.cwd())"],
    timeoutMs: 2_000
  });
  assert.equal(result.status, "completed");
  assert.equal(result.chunks.map((chunk) => chunk.data).join(""), await realpath(root));
});

test("marks timed out processes as expired", async (t) => {
  const { root } = await fixture(t);
  const executor = new SlaveProcessExecutor({ roots: [root], maxOutputBytes: 1024, maxTimeoutMs: 5_000 });
  const result = await executor.execute({
    jobId: "job-timeout",
    executable: process.execPath,
    argv: ["--input-type=module", "--eval", "setTimeout(() => {}, 10000)"],
    cwd: root,
    timeoutMs: 25
  });
  assert.equal(result.status, "expired");
});
