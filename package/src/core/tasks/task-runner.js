function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class NonRetryableTaskError extends Error {
  constructor(message) {
    super(message);
    this.name = "NonRetryableTaskError";
    this.retryable = false;
  }
}

export function createTaskRunner({ taskStore, dispatch, laneKey = (task) => task.id, onTerminalFailure, logger, claimLimit = 10 }) {
  if (!taskStore || typeof dispatch !== "function") {
    throw new Error("Task runner requires taskStore and dispatch");
  }

  async function reportTerminalFailure(task, updated, error) {
    const isTerminal = updated?.status === "failed"
      || updated?.status === "outcome_uncertain"
      || updated?.terminalFailure === true
      || updated?.authBlockedNew === true;
    if (!isTerminal || typeof onTerminalFailure !== "function") return;
    try {
      await onTerminalFailure({ task, result: updated, error });
    } catch (notificationError) {
      logger?.log("tasks", `task ${task.id} failure notification failed: ${errorMessage(notificationError)}`);
    }
  }

  const lanes = new Map();

  async function executeClaimedTask(task) {
    try {
      await taskStore.markExecutionStarted?.(task.id);
      await dispatch(task);
      await taskStore.complete(task.id);
      logger?.log("tasks", `task ${task.id} completed after confirmed execution`);
      return { taskId: task.id, status: "completed" };
    } catch (error) {
      const updated = error?.authBlocked === true
        ? await taskStore.blockAuth(task.id, error, error.authResolution)
        : await taskStore.retryOrFail(task.id, error, {
            retryable: error?.retryable !== false,
            ...(error?.outcomeUncertain === true ? { outcomeUncertain: true } : {})
          });
      const status = updated?.status || "missing";
      logger?.log("tasks", `task ${task.id} ${status}: ${errorMessage(error)}`);
      await reportTerminalFailure(task, updated, error);
      return { taskId: task.id, status, error: errorMessage(error) };
    }
  }

  function runClaimedTask(task) {
    const key = String(laneKey(task));
    const previous = lanes.get(key) || Promise.resolve();
    const running = previous.catch(() => {}).then(() => executeClaimedTask(task));
    lanes.set(key, running);
    running.then(
      () => { if (lanes.get(key) === running) lanes.delete(key); },
      () => { if (lanes.get(key) === running) lanes.delete(key); }
    );
    return running;
  }

  async function dispatchDueTasks() {
    const tasks = await taskStore.claimDue(claimLimit);
    return Promise.all(tasks.map(runClaimedTask));
  }

  return { dispatchDueTasks, runClaimedTask };
}
