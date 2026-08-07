import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { followLogFile, readRecentLogLines } from "../src/runtime/log-viewer.js";

const execFileAsync = promisify(execFile);

async function waitFor(check, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Condition was not met after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("reads only the requested most recent log lines", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arisa-log-"));
  const logFile = path.join(directory, "arisa.log");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(logFile, "one\ntwo\nthree\nfour\n", "utf8");

  const result = await readRecentLogLines(logFile, 2);

  assert.equal(result.text, "three\nfour");
  assert.equal(result.endsWithNewline, true);
  assert.equal(result.size, 19);
});

test("preserves an unterminated final log line", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arisa-log-"));
  const logFile = path.join(directory, "arisa.log");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(logFile, "one\ntwo", "utf8");

  const result = await readRecentLogLines(logFile, 1);

  assert.equal(result.text, "two");
  assert.equal(result.endsWithNewline, false);
});

test("follows appended logs and resumes from a replaced log file", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arisa-log-"));
  const logFile = path.join(directory, "arisa.log");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(logFile, "existing\n", "utf8");
  const initial = await readRecentLogLines(logFile, 10);
  const controller = new AbortController();
  let output = "";
  const following = followLogFile({
    logFile,
    initialSize: initial.size,
    initialIno: initial.ino,
    write: (content) => { output += content; },
    signal: controller.signal,
    pollIntervalMs: 10
  });

  await appendFile(logFile, "new\n", "utf8");
  await waitFor(() => output === "new\n");
  await rename(logFile, `${logFile}.old`);
  await writeFile(logFile, "rotated and longer\n", "utf8");
  await waitFor(() => output === "new\nrotated and longer\n");
  controller.abort();
  await following;

  assert.equal(output, "new\nrotated and longer\n");
});

test("arisa log prints the active package version and recent logs", async (t) => {
  const arisaHome = await mkdtemp(path.join(os.tmpdir(), "arisa-home-"));
  const stateDir = path.join(arisaHome, "state");
  t.after(() => rm(arisaHome, { recursive: true, force: true }));
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "arisa.log"), "first\nlatest\n", "utf8");

  const { stdout } = await execFileAsync(process.execPath, ["src/index.js", "log", "--no-follow"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, ARISA_HOME: arisaHome }
  });
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(stdout.split("\n")[0], `Arisa v${packageJson.version} | Recent logs`);
  assert.match(stdout, /first\nlatest\n$/);
});
