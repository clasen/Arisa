import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(packageDir, "src", "index.js");

async function isolatedEnvironment() {
  const home = await mkdtemp(path.join(os.tmpdir(), "arisa-cli-command-"));
  return {
    home,
    env: { ...process.env, ARISA_HOME: home }
  };
}

test("prints CLI help without starting the runtime", async (t) => {
  const isolated = await isolatedEnvironment();
  t.after(() => rm(isolated.home, { recursive: true, force: true }));

  const { stdout, stderr } = await execFileAsync(process.execPath, [entry, "--help"], {
    cwd: packageDir,
    env: isolated.env
  });

  assert.match(stdout, /^Usage: arisa/m);
  assert.match(stdout, /status\s+Show background service status/);
  assert.equal(stderr, "");
});

test("rejects unknown CLI commands instead of starting the runtime", async (t) => {
  const isolated = await isolatedEnvironment();
  t.after(() => rm(isolated.home, { recursive: true, force: true }));

  await assert.rejects(
    () => execFileAsync(process.execPath, [entry, "doctor"], {
      cwd: packageDir,
      env: isolated.env
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unknown Arisa command: doctor/);
      assert.doesNotMatch(error.stderr, /loading config|validating Pi session/);
      return true;
    }
  );
});
