import { purgeManagedDaemon } from "../core/tools/daemon-processes.js";
import { isDaemonProcess, listSystemProcesses, terminateProcess } from "./process-inspection.js";

export async function reapObsoleteDaemon({
  record,
  diagnostic,
  reason,
  timeoutMs,
  stopTimeoutMs,
  inspectProcesses = listSystemProcesses,
  stopProcess = terminateProcess,
  purgeDaemon = purgeManagedDaemon
} = {}) {
  const pid = diagnostic?.pid;
  if (pid) {
    let processes;
    try {
      processes = await inspectProcesses({ timeoutMs });
    } catch (error) {
      return {
        record,
        outcome: "obsolete-unverified",
        reason,
        diagnostic,
        error: `process inspection failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    const processRecord = processes.find((item) => item.pid === pid);
    if (!processRecord || !isDaemonProcess(processRecord, record)) {
      return { record, outcome: "obsolete-unverified", reason, diagnostic };
    }
    await stopProcess(pid, { forceAfterMs: stopTimeoutMs });
  }

  await purgeDaemon({ toolName: record.toolName, scope: record.scope });
  return {
    record,
    outcome: "obsolete-removed",
    reason,
    diagnostic,
    stoppedPid: pid || null
  };
}
