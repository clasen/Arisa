import {
  getChatArtifactsDir,
  getChatToolStateDir,
  getChatToolTmpDir,
  getToolStateDir,
  getToolTmpDir
} from "./paths.js";
import { ToolResourceNoteStore } from "../core/tools/tool-resource-note-store.js";
import { installBundledOfficialTool } from "../core/tools/official-tool-installer.js";
import { taskWithoutCallerRouting } from "../core/tasks/task-routing.js";

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

function normalizeArgs(args) {
  if (args == null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new Error("args must be an object");
  }
  return args;
}

function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isInteger(value) || value <= 0) return 20;
  return Math.min(value, 100);
}

function normalizeAcknowledgement(value) {
  if (value == null || value === "") return "";
  const acknowledgement = requireString(value, "acknowledgement").trim();
  if (acknowledgement.length > 500) throw new Error("acknowledgement must be at most 500 characters");
  return acknowledgement;
}

export function createArisaCapabilities({
  artifactStore,
  taskStore,
  toolRegistry,
  agentManager,
  resourceNotes = new ToolResourceNoteStore(),
  installOfficialTool = installBundledOfficialTool
} = {}) {
  async function dispatch({ method, toolName, chatId = null, params = {} } = {}) {
    const scopedToolName = requireToolName(toolName);

    if (method === "tools.list") {
      await toolRegistry.load();
      return toolRegistry.listWithRuntime(chatId);
    }

    if (method === "tools.help") {
      await toolRegistry.load();
      return toolRegistry.help(requireString(params.name, "name"));
    }

    if (method === "tools.skills") {
      await toolRegistry.load();
      return toolRegistry.resolveSkills(requireString(params.name, "name"));
    }

    if (method === "tools.setConfig") {
      await toolRegistry.load();
      return toolRegistry.setConfig(
        requireString(params.name, "name"),
        requireString(params.field, "field"),
        requireString(params.value, "value"),
        requireChatId(chatId, method)
      );
    }

    if (method === "tools.setResourceNote") {
      const scopedChatId = requireChatId(chatId, method);
      return resourceNotes.set(
        scopedChatId,
        scopedToolName,
        requireString(params.resourceId, "resourceId"),
        String(params.note ?? "")
      );
    }

    if (method === "tools.getResourceNote") {
      const scopedChatId = requireChatId(chatId, method);
      return {
        toolName: scopedToolName,
        resourceId: requireString(params.resourceId, "resourceId"),
        note: await resourceNotes.get(scopedChatId, scopedToolName, params.resourceId)
      };
    }

    if (method === "tools.run") {
      if (!agentManager?.runTool) {
        throw new Error("tools.run requires agentManager");
      }
      const scopedChatId = requireChatId(chatId, method);
      const targetToolName = requireString(params.name, "name");
      const chatArtifactStore = artifactStore.forChat(scopedChatId);
      const artifact = params.artifactId
        ? await chatArtifactStore.get(requireString(params.artifactId, "artifactId"))
        : null;
      if (params.artifactId && !artifact) {
        throw new Error(`Artifact not found: ${params.artifactId}`);
      }

      return agentManager.runTool({
        name: targetToolName,
        request: {
          artifact,
          text: params.text,
          resourceId: params.resourceId,
          args: normalizeArgs(params.args)
        },
        chatId: scopedChatId
      });
    }

    if (method === "tools.installOfficial") {
      const name = requireString(params.name, "name");
      if (params.confirmName !== name) {
        throw new Error("tools.installOfficial requires confirmName equal to name");
      }
      const installed = await installOfficialTool(name);
      await toolRegistry.load();
      return installed;
    }

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

    if (method === "artifacts.deliver") {
      const scopedChatId = requireChatId(chatId, method);
      const artifactId = requireString(params.artifactId, "artifactId");
      const artifact = await artifactStore.forChat(scopedChatId).get(artifactId);
      if (!artifact?.path) throw new Error(`Artifact not found or has no file: ${artifactId}`);
      if (!agentManager?.deliverArtifact) throw new Error("artifact delivery is unavailable");
      return agentManager.deliverArtifact({
        chatId: scopedChatId,
        artifact,
        caption: params.caption,
        method: params.method
      });
    }

    if (method === "tasks.add") {
      const scopedChatId = requireChatId(chatId, method);
      return taskStore.add(taskWithoutCallerRouting(params.task || {}), {
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

    if (method === "tasks.cancelAll") {
      const scopedChatId = requireChatId(chatId, method);
      return taskStore.cancelAll({ chatId: scopedChatId });
    }

    if (method === "agent.enqueueEvent") {
      const scopedChatId = requireChatId(chatId, method);
      const resourceId = String(params.resourceId || "").trim();
      return taskStore.add({
        kind: "agent_event",
        payload: {
          prompt: requireString(params.prompt, "prompt"),
          resourceId,
          acknowledgement: normalizeAcknowledgement(params.acknowledgement)
        }
      }, {
        payload: { chatId: scopedChatId },
        source: { type: "tool", toolName: scopedToolName, chatId: scopedChatId, resourceId }
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
