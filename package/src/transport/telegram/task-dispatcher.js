import { NonRetryableTaskError, createTaskRunner } from "../../core/tasks/task-runner.js";
import { buildAsyncEventPrompt, buildAsyncTaskPrompt } from "./prompt-builders.js";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function requireChatId(task) {
  const chatId = task.payload?.chatId;
  if (chatId == null || chatId === "") {
    throw new NonRetryableTaskError(`Task missing chatId: ${task.kind}`);
  }
  return chatId;
}

export function createTelegramTaskDispatcher({
  taskStore,
  sendMessage,
  enqueueAsyncPrompt,
  artifactStore,
  toolRegistry,
  resourceNotes,
  agentManager,
  logger
}) {
  async function dispatchAgentTask(task, chatId) {
    if (!task.payload.prompt) throw new NonRetryableTaskError("agent_task missing prompt");
    logger?.log("tasks", `running task ${task.id} for chat ${chatId}`);
    await enqueueAsyncPrompt({
      chatId,
      prompt: await buildAsyncTaskPrompt({ task, artifactStore, toolRegistry, resourceNotes, logger }),
      label: `scheduled task ${task.id}`,
      route: task.route
    });
  }

  async function dispatchAgentEvent(task, chatId) {
    if (!task.payload?.prompt) throw new NonRetryableTaskError("agent_event missing prompt");
    logger?.log("tasks", `agent event ${task.id} for chat ${chatId}`);
    const acknowledgement = String(task.payload?.acknowledgement || "").trim();
    if (acknowledgement) {
      try {
        await sendMessage(chatId, acknowledgement);
      } catch (error) {
        logger?.log("telegram", `agent event acknowledgement failed for chat ${chatId}: ${errorMessage(error)}`);
      }
    }
    await enqueueAsyncPrompt({
      chatId,
      prompt: await buildAsyncEventPrompt(task, resourceNotes),
      label: `agent event ${task.id}`,
      route: task.route
    });
  }

  async function dispatchPollTool(task, chatId) {
    const toolName = task.payload?.toolName;
    if (!toolName) throw new NonRetryableTaskError("poll_tool missing toolName");
    logger?.log("tasks", `polling tool ${toolName} (task ${task.id}) for chat ${chatId}`);
    const result = await agentManager.runTool({
      name: toolName,
      request: { args: task.payload.args || {} },
      chatId
    });
    if (result?.ok === false) {
      const error = new Error(result.error || `poll_tool ${toolName} failed`);
      if (result.status === "needs_config") error.retryable = false;
      if (result.status === "outcome_uncertain") {
        error.retryable = false;
        error.outcomeUncertain = true;
      }
      throw error;
    }
  }

  async function dispatchTask(task) {
    const chatId = requireChatId(task);
    if (task.kind === "agent_task") return dispatchAgentTask(task, chatId);
    if (task.kind === "agent_event") return dispatchAgentEvent(task, chatId);
    if (task.kind === "poll_tool") return dispatchPollTool(task, chatId);
    throw new NonRetryableTaskError(`Unsupported task: ${task.kind}`);
  }

  const runner = createTaskRunner({ taskStore, dispatch: dispatchTask, logger });
  return { dispatchTask, dispatchDueTasks: runner.dispatchDueTasks, runClaimedTask: runner.runClaimedTask };
}
