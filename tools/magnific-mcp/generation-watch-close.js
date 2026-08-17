import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function terminalClaimPath(stateDir, jobId) {
  return path.join(stateDir, "terminal-event-claims", `${jobId}.json`);
}

export async function terminalEventClaimed(stateDir, jobId) {
  try {
    await stat(terminalClaimPath(stateDir, jobId));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function claimTerminalEvent(stateDir, jobId, status) {
  const filePath = terminalClaimPath(stateDir, jobId);
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, `${JSON.stringify({ status, claimedAt: new Date().toISOString() }, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

function isMatchingWatch(task, jobId, watchToken) {
  const args = task?.payload?.args || {};
  return task?.kind === "poll_tool"
    && task?.payload?.toolName === "magnific-mcp"
    && args.action === "watch-generation"
    && args.jobId === jobId
    && args.watchToken === watchToken;
}

export async function cancelPendingGenerationWatches(arisa, jobId, watchToken) {
  const tasks = await arisa.tasks.list({ status: "pending", kind: "poll_tool" });
  const matches = (Array.isArray(tasks) ? tasks : []).filter((task) => isMatchingWatch(task, jobId, watchToken));
  await Promise.all(matches.map((task) => arisa.tasks.cancel({ taskId: task.id })));
  return matches.length;
}
