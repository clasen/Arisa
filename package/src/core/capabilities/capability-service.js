import path from "node:path";
import {
  getChatArtifactsDir,
  getChatToolStateDir,
  getChatToolTmpDir,
  getToolStateDir,
  getToolTmpDir
} from "../../runtime/paths.js";
import { ToolResourceNoteStore } from "../tools/tool-resource-note-store.js";
import { installBundledOfficialTool } from "../tools/official-tool-installer.js";
import { searchOfficialToolCatalog } from "../tools/official-tool-catalog.js";
import { taskWithoutCallerRouting } from "../tasks/task-routing.js";

export const defaultScheduledTaskListLimit = 50;
export const maxScheduledTaskListLimit = 100;

function requireToolName(toolName) {
  if (typeof toolName !== "string" || !toolName.trim()) throw new Error("toolName is required");
  return toolName.trim();
}

function requireChatId(chatId, method) {
  if (chatId == null || chatId === "") throw new Error(`${method} requires chatId`);
  return chatId;
}

function requireString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${fieldName} is required`);
  return value;
}

function normalizeArgs(args) {
  if (args == null) return {};
  if (typeof args !== "object" || Array.isArray(args)) throw new Error("args must be an object");
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

function inferDeliveryMethod(artifact) {
  if (artifact.kind === "audio" || (artifact.mimeType || "").startsWith("audio/")) return "audio";
  if (artifact.kind === "image" || (artifact.mimeType || "").startsWith("image/")) return "photo";
  if (artifact.kind === "video" || (artifact.mimeType || "").startsWith("video/")) return "video";
  return "document";
}

function containsAbsolutePath(value) {
  if (typeof value !== "string") return false;
  return /(^|\s)(\/[^\s]|[A-Za-z]:[\\/])/.test(value);
}

export function resolveMediaCaption(caption) {
  return caption && !containsAbsolutePath(caption) ? caption : undefined;
}

export function selectScheduledTasks(tasks = [], { status, limit = defaultScheduledTaskListLimit } = {}) {
  const parsedLimit = Number(limit);
  const resolvedLimit = Math.min(
    Math.max(Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : defaultScheduledTaskListLimit, 1),
    maxScheduledTaskListLimit
  );
  const allTasks = Array.isArray(tasks) ? tasks : [];
  const orderedTasks = status
    ? [...allTasks].reverse()
    : [
        ...allTasks.filter((task) => task.status === "pending" || task.status === "running").reverse(),
        ...allTasks.filter((task) => task.status !== "pending" && task.status !== "running").reverse()
      ];
  const visibleTasks = orderedTasks.slice(0, resolvedLimit);
  return {
    tasks: visibleTasks,
    total: allTasks.length,
    returned: visibleTasks.length,
    limit: resolvedLimit,
    truncated: visibleTasks.length < allTasks.length
  };
}

async function catalogSearch(searchCatalog, query) {
  try {
    return await searchCatalog(query);
  } catch (error) {
    return { unavailable: true, error: error?.message || String(error), matches: [] };
  }
}

export function createCapabilityService({
  artifactStore,
  taskStore,
  toolRegistry,
  toolExecutor,
  resourceNotes = new ToolResourceNoteStore(),
  installOfficialTool = installBundledOfficialTool,
  searchCatalog = searchOfficialToolCatalog,
  logger
} = {}) {
  async function execute({ method, actorToolName, chatId = null, params = {}, context = {} } = {}) {
    const actor = requireToolName(actorToolName);
    if (context.allowedMethods && !context.allowedMethods.has(method)) {
      throw new Error(`unknown ${context.unknownMethodLabel || "capability"} method: ${method}`);
    }

    if (method === "tools.list") {
      await toolRegistry.load();
      const query = String(params.query || "").trim();
      const cliTools = query
        ? toolRegistry.search(query).map((tool) => ({ ...tool, source: "arisa-modular", invocation: "run_tool" }))
        : (await toolRegistry.listWithRuntime(chatId)).map((tool) => ({ ...tool, source: "arisa-modular", invocation: "run_tool" }));
      const catalogFallback = query && cliTools.length === 0 ? await catalogSearch(searchCatalog, query) : null;
      const coreTools = query ? [] : context.coreTools || [];
      const nativeTools = query ? [] : context.nativeTools || [];
      return {
        query: query || null,
        ...(context.workspaceDir ? { workspaceDir: context.workspaceDir } : {}),
        coreTools,
        nativeTools,
        cliTools,
        officialCatalogMatches: Array.isArray(catalogFallback) ? catalogFallback : catalogFallback?.matches || [],
        catalogFallback: catalogFallback && !Array.isArray(catalogFallback) ? catalogFallback : null,
        tools: query ? cliTools : [...coreTools.filter((tool) => tool.enabled !== false), ...nativeTools.filter((tool) => tool.enabled !== false), ...cliTools]
      };
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
      const name = context.allowTargetToolName && params.name
        ? requireString(params.name, "name")
        : actor;
      return resourceNotes.set(
        requireChatId(chatId, method),
        name,
        requireString(params.resourceId, "resourceId"),
        String(params.note ?? "")
      );
    }

    if (method === "tools.getResourceNote") {
      const scopedChatId = requireChatId(chatId, method);
      const name = context.allowTargetToolName && params.name
        ? requireString(params.name, "name")
        : actor;
      const resourceId = requireString(params.resourceId, "resourceId");
      return { toolName: name, resourceId, note: await resourceNotes.get(scopedChatId, name, resourceId) };
    }

    if (method === "tools.run") {
      if (!toolExecutor?.runTool) throw new Error("tools.run requires toolExecutor");
      const scopedChatId = requireChatId(chatId, method);
      const targetToolName = requireString(params.name, "name");
      const chatArtifactStore = artifactStore.forChat(scopedChatId);
      const artifact = params.artifactId
        ? await chatArtifactStore.get(requireString(params.artifactId, "artifactId"))
        : null;
      if (params.artifactId && !artifact) {
        if (context.returnMissingArtifact) return { ok: false, status: "failed", error: `Artifact not found: ${params.artifactId}` };
        throw new Error(`Artifact not found: ${params.artifactId}`);
      }
      const result = await toolExecutor.runTool({
        name: targetToolName,
        request: {
          artifact,
          text: params.text,
          resourceId: params.resourceId,
          args: normalizeArgs(params.args)
        },
        chatId: scopedChatId,
        taskContext: context.taskContext || null
      });
      if (params.deliver && result.output?.artifactId) {
        const generated = await chatArtifactStore.get(result.output.artifactId);
        if (generated?.path) {
          result.sent = await deliverArtifact({
            artifact: generated,
            chatId: scopedChatId,
            method: params.method,
            caption: params.caption,
            context
          });
        }
      }
      return result;
    }

    if (method === "tools.installOfficial") {
      const name = requireString(params.name, "name");
      if (params.confirmName !== name) throw new Error("tools.installOfficial requires confirmName equal to name");
      const installed = await installOfficialTool(name);
      await toolRegistry.load();
      return installed;
    }

    if (method === "artifacts.createText") {
      const scopedChatId = requireChatId(chatId, method);
      return artifactStore.forChat(scopedChatId).createText({
        text: requireString(params.text, "text"),
        mimeType: params.mimeType || "text/plain",
        source: { type: "tool", toolName: actor, chatId: scopedChatId },
        metadata: params.metadata || {}
      });
    }

    if (method === "artifacts.listRecent") {
      return artifactStore.forChat(requireChatId(chatId, method)).listRecent(normalizeLimit(params.limit));
    }

    if (method === "artifacts.get") {
      return artifactStore.forChat(requireChatId(chatId, method)).get(requireString(params.artifactId, "artifactId"));
    }

    if (method === "artifacts.deliver") {
      const scopedChatId = requireChatId(chatId, method);
      const artifactId = requireString(params.artifactId, "artifactId");
      const artifact = await artifactStore.forChat(scopedChatId).get(artifactId);
      if (!artifact) {
        if (context.returnMissingArtifact) return { ok: false, status: "failed", error: `Artifact not found: ${artifactId}` };
        throw new Error(`Artifact not found or has no file: ${artifactId}`);
      }
      if (!artifact.path) {
        if (context.returnMissingArtifact) return { ok: false, status: "failed", error: `Artifact ${artifactId} has no file to deliver.` };
        throw new Error(`Artifact not found or has no file: ${artifactId}`);
      }
      return deliverArtifact({ artifact, chatId: scopedChatId, caption: params.caption, method: params.method, context });
    }

    if (method === "tasks.add") {
      const scopedChatId = requireChatId(chatId, method);
      return taskStore.add(taskWithoutCallerRouting(params.task || {}), {
        payload: { chatId: scopedChatId },
        source: { type: "tool", toolName: actor, chatId: scopedChatId }
      });
    }

    if (method === "tasks.list") {
      const scopedChatId = requireChatId(chatId, method);
      const tasks = await taskStore.list({ chatId: scopedChatId, status: params.status || undefined, kind: params.kind || undefined });
      return context.selectScheduledTasks
        ? selectScheduledTasks(tasks, { status: params.status, limit: params.limit })
        : tasks;
    }

    if (method === "tasks.cancel") {
      const scopedChatId = requireChatId(chatId, method);
      const taskId = requireString(params.taskId || params.id, "taskId");
      const task = await taskStore.get(taskId);
      if (!task) return context.wrapTaskResult ? { ok: false, error: "Task not found" } : null;
      if (String(task.payload?.chatId) !== String(scopedChatId)) {
        if (context.wrapTaskResult) return { ok: false, error: "Task not found" };
        throw new Error("task does not belong to chatId");
      }
      const cancelled = await taskStore.cancel(taskId);
      return context.wrapTaskResult ? { ok: true, task: cancelled } : cancelled;
    }

    if (method === "tasks.cancelAll") {
      const tasks = await taskStore.cancelAll({ chatId: requireChatId(chatId, method) });
      return context.wrapTaskResult ? { ok: true, cancelled: tasks.length, tasks } : tasks;
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
        source: { type: "tool", toolName: actor, chatId: scopedChatId, resourceId }
      });
    }

    if (method === "telegram.createTopic") {
      if (typeof context.telegram?.createForumTopic !== "function") return { ok: false, error: "Telegram topic creation is unavailable in this chat." };
      return context.telegram.createForumTopic(requireString(params.name, "name").trim(), requireString(params.context, "context").trim());
    }

    if (method === "telegram.initializeTopic") {
      if (typeof context.telegram?.initializeForumTopic !== "function") return { ok: false, error: "Telegram topic initialization is unavailable in this chat." };
      return context.telegram.initializeForumTopic({
        messageThreadId: params.messageThreadId,
        name: requireString(params.name, "name").trim(),
        context: requireString(params.context, "context").trim()
      });
    }

    if (method === "paths.getChatToolStateDir") return getChatToolStateDir(requireChatId(chatId, method), actor);
    if (method === "paths.getToolStateDir") return getToolStateDir(actor);
    if (method === "paths.getChatToolTmpDir") return getChatToolTmpDir(requireChatId(chatId, method), actor);
    if (method === "paths.getToolTmpDir") return getToolTmpDir(actor);
    if (method === "paths.getChatArtifactsDir") return getChatArtifactsDir(requireChatId(chatId, method));

    throw new Error(`unknown ${context.unknownMethodLabel || "capability"} method: ${method}`);
  }

  async function deliverArtifact({ artifact, chatId, caption, method, context }) {
    const resolvedMethod = method || artifact.metadata?.delivery?.method || inferDeliveryMethod(artifact);
    const resolvedCaption = resolveMediaCaption(caption);
    if (typeof context.delivery === "function") {
      logger?.log("capabilities", `deliver artifact ${artifact.id} as ${resolvedMethod}`);
      return context.delivery(artifact, { method: resolvedMethod, caption: resolvedCaption, filename: path.basename(artifact.path) });
    }
    if (!toolExecutor?.deliverArtifact) throw new Error("artifact delivery is unavailable");
    return toolExecutor.deliverArtifact({ chatId, artifact, caption: resolvedCaption, method: resolvedMethod });
  }

  return { execute };
}
