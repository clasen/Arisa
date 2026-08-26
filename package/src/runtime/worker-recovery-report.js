import crypto from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readRecentLogLines } from "./log-viewer.js";
import { arisaPackageDir, serviceLogFile, stateDir, tasksFile } from "../platform/paths.js";

export const workerRecoveryReportFile = path.join(stateDir, "worker-recovery-report.json");

function boundedText(value, maximum = 300) {
  return String(value || "").trim().slice(0, maximum);
}

export async function recordUnexpectedWorkerExit(input, { reportFile = workerRecoveryReportFile } = {}) {
  const report = {
    id: crypto.randomUUID(),
    occurredAt: input.occurredAt || new Date().toISOString(),
    runtimeMs: Math.max(0, Number(input.runtimeMs || 0)),
    restartDelayMs: Math.max(0, Number(input.restartDelayMs || 0)),
    consecutiveFailures: Math.max(1, Number(input.consecutiveFailures || 1)),
    code: input.code == null ? null : boundedText(input.code, 40),
    signal: input.signal == null ? null : boundedText(input.signal, 40),
    detail: boundedText(input.detail)
  };
  await mkdir(path.dirname(reportFile), { recursive: true, mode: 0o700 });
  const temporary = `${reportFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, reportFile);
  return report;
}

function logTimestamp(line) {
  const match = String(line).match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
  if (!match) return null;
  const value = new Date(match[1].replace(" ", "T")).getTime();
  return Number.isFinite(value) ? value : null;
}

function relevantLogLines(lines, report) {
  const occurredAt = new Date(report.occurredAt).getTime();
  if (!Number.isFinite(occurredAt)) return lines.slice(-300);
  const earliest = occurredAt - 2 * 60_000;
  const latest = occurredAt + 5_000;
  let start = -1;
  let end = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const timestamp = logTimestamp(lines[index]);
    if (timestamp == null) continue;
    if (start === -1 && timestamp >= earliest) start = index;
    if (timestamp <= latest) end = index;
  }
  if (start === -1 || end < start) return lines.slice(-300);
  return lines.slice(start, end + 1);
}

export function summarizeRecoveryEvidence(lines, report) {
  const relevant = relevantLogLines(lines, report);
  const outOfMemory = relevant.some((line) => /heap limit|heap out of memory|allocation failed.*memory/i.test(line));
  const tools = new Map();
  for (const line of relevant) {
    const match = line.match(/\[agent\] run_tool ([a-z0-9-]+)/i);
    if (match) tools.set(match[1], (tools.get(match[1]) || 0) + 1);
  }
  return {
    cause: outOfMemory
      ? "JavaScript heap out of memory"
      : report.signal
        ? `worker terminated by ${report.signal}`
        : `worker exited with code ${report.code ?? "unknown"}`,
    tools: [...tools.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3)
  };
}

async function interruptedTaskCount(report, file = tasksFile) {
  try {
    const document = JSON.parse(await readFile(file, "utf8"));
    const tasks = Array.isArray(document) ? document : document.tasks || [];
    const occurredAt = new Date(report.occurredAt).getTime();
    return tasks.filter((task) => {
      const updatedAt = new Date(task.updatedAt || 0).getTime();
      return task.lastOutcome === "outcome_uncertain"
        && /interrupted before confirmation/i.test(task.lastError || "")
        && Number.isFinite(occurredAt)
        && Math.abs(updatedAt - occurredAt) <= 2 * 60_000;
    }).length;
  } catch {
    return 0;
  }
}

async function runtimeVersion() {
  try {
    return String(JSON.parse(await readFile(path.join(arisaPackageDir, "package.json"), "utf8")).version || "unknown");
  } catch {
    return "unknown";
  }
}

export async function loadWorkerRecoveryReport({
  reportFile = workerRecoveryReportFile,
  logFile = serviceLogFile,
  taskFile = tasksFile,
  readLines = readRecentLogLines,
  getVersion = runtimeVersion
} = {}) {
  let report;
  try {
    report = JSON.parse(await readFile(reportFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const snapshot = await readLines(logFile, 1_000).catch(() => []);
  const lines = Array.isArray(snapshot) ? snapshot : String(snapshot?.text || "").split(/\r?\n/);
  const evidence = summarizeRecoveryEvidence(lines, report);
  const uncertain = await interruptedTaskCount(report, taskFile);
  const version = await getVersion();
  const context = evidence.tools.length
    ? `Recent tool activity: ${evidence.tools.map(([name, count]) => `${name} ×${count}`).join(", ")}.`
    : null;
  return {
    report,
    text: [
      "Arisa recovered automatically after an unexpected worker exit.",
      `Cause: ${evidence.cause}.`,
      context,
      uncertain ? `${uncertain} scheduled execution${uncertain === 1 ? " was" : "s were"} marked outcome-uncertain and not replayed.` : null,
      `Recovery: worker restarted after ${Math.round(report.restartDelayMs / 100) / 10}s; Arisa ${version} is running.`
    ].filter(Boolean).join("\n")
  };
}

export async function consumeWorkerRecoveryReport(reportId, { reportFile = workerRecoveryReportFile } = {}) {
  try {
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    if (report.id !== reportId) return false;
    await rm(reportFile, { force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
