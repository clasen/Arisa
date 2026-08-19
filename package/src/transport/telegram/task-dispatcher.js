import { buildAsyncEventPrompt, buildAsyncTaskPrompt } from "./prompt-builders.js";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
    if (!task.payload.prompt) {
      await taskStore.fail(task.id, "agent_task missing prompt");
      return;
    }
    logger?.log("tasks", `running task ${task.id} for chat ${chatId}`);
    await enqueueAsyncPrompt({
      chatId,
      prompt: await buildAsyncTaskPrompt({ task, artifactStore, toolRegistry, resourceNotes, logger }),
      label: `scheduled task ${task.id}`,
      telegramContext: task.payload.telegramContext
    });
    await taskStore.complete(task.id);
  }

  async function dispatchAgentEvent(task, chatId) {
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
      telegramContext: task.payload.telegramContext
    });
    await taskStore.complete(task.id);
  }

  async function dispatchPollTool(task, chatId) {
    const toolName = task.payload?.toolName;
    if (!toolName) {
      await taskStore.fail(task.id, "poll_tool missing toolName");
      return;
    }
    logger?.log("tasks", `polling tool ${toolName} (task ${task.id}) for chat ${chatId}`);
    try {
      await agentManager.runTool({
        name: toolName,
        request: { args: task.payload.args || {} },
        chatId
      });
    } catch (error) {
      logger?.log("tasks", `poll_tool ${toolName} failed: ${errorMessage(error)}`);
    }
    await taskStore.complete(task.id);
  }

  async function dispatchTask(task) {
    const chatId = task.payload?.chatId;
    if (!chatId) {
      await taskStore.fail(task.id, `Task missing chatId: ${task.kind}`);
      return;
    }
    if (task.kind === "agent_task") return dispatchAgentTask(task, chatId);
    if (task.kind === "agent_event") return dispatchAgentEvent(task, chatId);
    if (task.kind === "poll_tool") return dispatchPollTool(task, chatId);
    await taskStore.fail(task.id, `Unsupported task: ${task.kind}`);
  }

  async function dispatchDueTasks() {
    const tasks = await taskStore.claimDue(10);
    for (const task of tasks) {
      try {
        await dispatchTask(task);
      } catch (error) {
        await taskStore.fail(task.id, errorMessage(error));
      }
    }
  }

  return { dispatchTask, dispatchDueTasks };
}
