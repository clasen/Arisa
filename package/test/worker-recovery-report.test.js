import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  consumeWorkerRecoveryReport,
  loadWorkerRecoveryReport,
  recordUnexpectedWorkerExit,
  summarizeRecoveryEvidence
} from "../src/runtime/worker-recovery-report.js";

function localLogTimestamp(date) {
  const two = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

test("summarizes only bounded crash evidence", () => {
  const evidence = summarizeRecoveryEvidence([
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    "[agent] run_tool web-browser",
    "[agent] run_tool web-browser",
    "[agent] run_tool campaign-draft-runner"
  ], { occurredAt: "invalid", signal: "SIGABRT" });

  assert.equal(evidence.cause, "JavaScript heap out of memory");
  assert.deepEqual(evidence.tools, [["web-browser", 2], ["campaign-draft-runner", 1]]);
});

test("persists, formats, and consumes one automatic recovery report", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arisa-worker-recovery-"));
  const reportFile = path.join(directory, "report.json");
  const taskFile = path.join(directory, "tasks.json");
  const occurredAt = new Date();
  const report = await recordUnexpectedWorkerExit({
    occurredAt: occurredAt.toISOString(),
    runtimeMs: 10_000,
    restartDelayMs: 2_000,
    consecutiveFailures: 1,
    code: null,
    signal: "SIGABRT",
    detail: "signal=SIGABRT"
  }, { reportFile });
  await writeFile(taskFile, `${JSON.stringify({ tasks: [{
    updatedAt: occurredAt.toISOString(),
    lastOutcome: "outcome_uncertain",
    lastError: "execution interrupted before confirmation"
  }] })}\n`);
  const timestamp = localLogTimestamp(occurredAt);
  const recovery = await loadWorkerRecoveryReport({
    reportFile,
    taskFile,
    readLines: async () => ({ text: [
      `[${timestamp}] [agent] run_tool web-browser`,
      `[${timestamp}] [agent] run_tool web-browser`,
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      `[${timestamp}] [service] worker exited unexpectedly (signal=SIGABRT)`
    ].join("\n") }),
    getVersion: async () => "5.1.70"
  });

  assert.match(recovery.text, /Cause: JavaScript heap out of memory/);
  assert.match(recovery.text, /web-browser ×2/);
  assert.match(recovery.text, /1 scheduled execution was marked outcome-uncertain and not replayed/);
  assert.match(recovery.text, /restarted after 2s; Arisa 5\.1\.70 is running/);
  assert.equal(await consumeWorkerRecoveryReport(report.id, { reportFile }), true);
  await assert.rejects(() => readFile(reportFile), /ENOENT/);
  await rm(directory, { recursive: true, force: true });
});
