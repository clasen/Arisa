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

export function createTaskRunner({ taskStore, dispatch, logger, claimLimit = 10 }) {
  if (!taskStore || typeof dispatch !== "function") {
    throw new Error("Task runner requires taskStore and dispatch");
  }

  async function runClaimedTask(task) {
    try {
      await dispatch(task);
      await taskStore.complete(task.id);
      logger?.log("tasks", `task ${task.id} completed after confirmed execution`);
      return { taskId: task.id, status: "completed" };
    } catch (error) {
      const retryOptions = { retryable: error?.retryable !== false };
      if (error?.outcomeUncertain === true) retryOptions.outcomeUncertain = true;
      const updated = await taskStore.retryOrFail(task.id, error, retryOptions);
      const status = updated?.status || "missing";
      logger?.log("tasks", `task ${task.id} ${status}: ${errorMessage(error)}`);
      return { taskId: task.id, status, error: errorMessage(error) };
    }
  }

  async function dispatchDueTasks() {
    const tasks = await taskStore.claimDue(claimLimit);
    return Promise.all(tasks.map(runClaimedTask));
  }

  return { dispatchDueTasks, runClaimedTask };
}
