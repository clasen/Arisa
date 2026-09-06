import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const exec = promisify(execFile);

test("status runs with a 24 MiB heap without loading the agent, SQLite or TUI", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "arisa-cli-memory-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const entry = new URL("../src/index.js", import.meta.url);
  const {stdout, stderr} = await exec(process.execPath, ["--max-old-space-size=24", entry.pathname, "status"], {
    env: {...process.env, ARISA_HOME: home}, timeout: 15_000
  });
  assert.match(stdout, /Arisa is not running/);
  assert.equal(stderr, "");
  const source = await readFile(entry, "utf8");
  assert.doesNotMatch(source, /^import .*from .*runtime\/(create-app|bootstrap|tui|slave-cli)\.js/m);
});
