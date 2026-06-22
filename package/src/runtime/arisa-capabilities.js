import {
  getChatArtifactsDir,
  getChatToolStateDir,
  getChatToolTmpDir,
  getToolStateDir,
  getToolTmpDir
} from "./paths.js";

function requireToolName(toolName) {
  if (typeof toolName !== "string" || !toolName.trim()) {
    throw new Error("toolName is required");
  }
  return toolName.trim();
}

function requireChatId(chatId, method) {
  if (chatId == null || chatId === "") {
    throw new Error(`${method} requires chatId`);
  }
  return chatId;
}

function requireString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isInteger(value) || value <= 0) return 20;
  return Math.min(value, 100);
}

export function createArisaCapabilities({ artifactStore, taskStore } = {}) {
  async function dispatch({ method, toolName, chatId = null, params = {} } = {}) {
    const scopedToolName = requireToolName(toolName);

    if (method === "artifacts.createText") {
      const scopedChatId = requireChatId(chatId, method);
      return artifactStore.forChat(scopedChatId).createText({
        text: requireString(params.text, "text"),
        mimeType: params.mimeType || "text/plain",
        source: { type: "tool", toolName: scopedToolName, chatId: scopedChatId },
        metadata: params.metadata || {}
      });
    }

    if (method === "artifacts.listRecent") {
      const scopedChatId = requireChatId(chatId, method);
      return artifactStore.forChat(scopedChatId).listRecent(normalizeLimit(params.limit));
    }

    if (method === "artifacts.get") {
      const scopedChatId = requireChatId(chatId, method);
      return artifactStore.forChat(scopedChatId).get(requireString(params.artifactId, "artifactId"));
    }

    if (method === "tasks.add") {
      const scopedChatId = requireChatId(chatId, method);
      return taskStore.add(params.task || {}, {
        payload: { chatId: scopedChatId },
        source: { type: "tool", toolName: scopedToolName, chatId: scopedChatId }
      });
    }

    if (method === "tasks.list") {
      const scopedChatId = requireChatId(chatId, method);
      return taskStore.list({
        chatId: scopedChatId,
        status: params.status || undefined,
        kind: params.kind || undefined
      });
    }

    if (method === "tasks.cancel") {
      const scopedChatId = requireChatId(chatId, method);
      const taskId = requireString(params.taskId, "taskId");
      const task = await taskStore.get(taskId);
      if (!task) return null;
      if (String(task.payload?.chatId) !== String(scopedChatId)) {
        throw new Error("task does not belong to chatId");
      }
      return taskStore.cancel(taskId);
    }

    if (method === "agent.enqueueEvent") {
      const scopedChatId = requireChatId(chatId, method);
      return taskStore.add({
        kind: "agent_event",
        payload: { prompt: requireString(params.prompt, "prompt") }
      }, {
        payload: { chatId: scopedChatId },
        source: { type: "tool", toolName: scopedToolName, chatId: scopedChatId }
      });
    }

    if (method === "paths.getChatToolStateDir") {
      return getChatToolStateDir(requireChatId(chatId, method), scopedToolName);
    }

    if (method === "paths.getToolStateDir") {
      return getToolStateDir(scopedToolName);
    }

    if (method === "paths.getChatToolTmpDir") {
      return getChatToolTmpDir(requireChatId(chatId, method), scopedToolName);
    }

    if (method === "paths.getToolTmpDir") {
      return getToolTmpDir(scopedToolName);
    }

    if (method === "paths.getChatArtifactsDir") {
      return getChatArtifactsDir(requireChatId(chatId, method));
    }

    throw new Error(`unknown IPC method: ${method}`);
  }

  return { dispatch };
}
