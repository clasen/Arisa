import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getCoreCodingTools } from "./core-tools.js";
import { maxScheduledTaskListLimit } from "../capabilities/capability-service.js";

function jsonResult(result, text = JSON.stringify(result, null, 2)) {
  return { content: [{ type: "text", text }], details: result };
}

function nativeTools(policy) {
  return [{
    name: "system_shell",
    source: "arisa-native",
    description: "Run native system shell commands in the active Arisa workspace.",
    workspaceDir: policy.workspaceDir,
    shell: policy.shell.shellPath || (process.platform === "win32" ? "powershell" : "sh"),
    enabled: !(policy.excludeTools || []).includes("system_shell")
  }];
}

export function createPiCapabilityTools({ capabilityService, telegram, chatId, policy, logger, toolFanout }) {
  if (!capabilityService?.execute) throw new Error("Pi capability tools require CapabilityService");

  const baseContext = {
    telegram,
    returnMissingArtifact: true,
    selectScheduledTasks: true,
    wrapTaskResult: true,
    allowTargetToolName: true,
    delivery: async (artifact, options) => {
      logger?.log("agent", `deliver artifact ${artifact.id} as ${options.method}`);
      await telegram.sendMedia(artifact.path, options);
      return {
        method: options.method,
        fileName: options.filename,
        artifactId: artifact.id
      };
    }
  };

  const runWithFanout = (work) => toolFanout?.run ? toolFanout.run(work) : work();
  const execute = (actorToolName, method, params = {}, context = {}) => capabilityService.execute({
    method,
    actorToolName,
    chatId,
    params,
    context: {
      ...baseContext,
      taskContext: telegram.getTaskContext(),
      ...context
    }
  });

  return [
    defineTool({
      name: "list_tools",
      label: "List tools",
      description: "List Arisa tools, or search installed tool metadata by capability with automatic official-catalog fallback.",
      parameters: Type.Object({ query: Type.Optional(Type.String()) }),
      execute: async (_id, params) => jsonResult(await execute("list_tools", "tools.list", params, {
        workspaceDir: policy.workspaceDir,
        coreTools: getCoreCodingTools({ tools: policy.tools, excludeTools: policy.excludeTools }),
        nativeTools: nativeTools(policy)
      }))
    }),
    defineTool({
      name: "tool_help",
      label: "Tool help",
      description: "Show --help text for a CLI tool.",
      parameters: Type.Object({ name: Type.String() }),
      execute: async (_id, params) => {
        const help = await execute("tool_help", "tools.help", params);
        return { content: [{ type: "text", text: help }], details: { help } };
      }
    }),
    defineTool({
      name: "tool_skills",
      label: "Tool skills",
      description: "Show skills assigned to a CLI tool via its manifest skillHints.",
      parameters: Type.Object({ name: Type.String() }),
      execute: async (_id, params) => {
        const skills = await execute("tool_skills", "tools.skills", params);
        const visible = skills.map(({ content, ...item }) => item);
        return jsonResult(visible);
      }
    }),
    defineTool({
      name: "set_tool_config",
      label: "Set tool config",
      description: "Write a tool config value scoped to the current chat.",
      parameters: Type.Object({ name: Type.String(), field: Type.String(), value: Type.String() }),
      execute: async (_id, params) => jsonResult(await execute("set_tool_config", "tools.setConfig", params))
    }),
    defineTool({
      name: "set_tool_resource_note",
      label: "Set tool resource note",
      description: "Set or clear a deterministic chat-scoped note of up to 200 characters for one tool resource.",
      parameters: Type.Object({
        name: Type.String(),
        resourceId: Type.String(),
        note: Type.String()
      }),
      execute: async (_id, params) => jsonResult(await execute("set_tool_resource_note", "tools.setResourceNote", params))
    }),
    defineTool({
      name: "run_tool",
      label: "Run tool",
      description: "Run a CLI tool using text input or an artifactId. Inspect the returned status/resolution fields. If a tool reports missing config, ask the user naturally, use set_tool_config, and retry. Set `deliver: true` to also send the generated file to the chat in one step (only when you want the user to receive it now, not for intermediate pipe steps).",
      parameters: Type.Object({
        name: Type.String(),
        artifactId: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
        resourceId: Type.Optional(Type.String()),
        args: Type.Optional(Type.Record(Type.String(), Type.String())),
        deliver: Type.Optional(Type.Boolean())
      }),
      execute: async (_id, params) => jsonResult(await runWithFanout(
        () => execute("run_tool", "tools.run", params)
      ))
    }),
    defineTool({
      name: "list_scheduled_tasks",
      label: "List scheduled tasks",
      description: "List scheduled async tasks for the current Telegram chat. Results default to 50 tasks, always include pending/running tasks, and accept an optional limit up to 100.",
      parameters: Type.Object({
        status: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxScheduledTaskListLimit }))
      }),
      execute: async (_id, params) => jsonResult(await execute("list_scheduled_tasks", "tasks.list", params))
    }),
    defineTool({
      name: "cancel_scheduled_task",
      label: "Cancel scheduled task",
      description: "Cancel one scheduled async task by id for the current Telegram chat.",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, params) => jsonResult(await execute("cancel_scheduled_task", "tasks.cancel", params))
    }),
    defineTool({
      name: "cancel_all_scheduled_tasks",
      label: "Cancel all scheduled tasks",
      description: "Cancel all pending or running async tasks for the current Telegram chat.",
      parameters: Type.Object({}),
      execute: async () => jsonResult(await execute("cancel_all_scheduled_tasks", "tasks.cancelAll"))
    }),
    defineTool({
      name: "create_telegram_topic",
      label: "Create Telegram topic",
      description: "Create and initialize a new topic in the current owner-only Telegram forum. Topic names are dynamic, and context seeds the isolated session without copying unrelated history.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 128 }),
        context: Type.String({ minLength: 1, maxLength: 4000 })
      }),
      execute: async (_id, params) => jsonResult(await execute("create_telegram_topic", "telegram.createTopic", params))
    }),
    defineTool({
      name: "initialize_telegram_topic",
      label: "Initialize Telegram topic",
      description: "Seed or replace the isolated context of an existing topic in the current owner-only Telegram forum.",
      parameters: Type.Object({
        messageThreadId: Type.Integer({ minimum: 2 }),
        name: Type.String({ minLength: 1, maxLength: 128 }),
        context: Type.String({ minLength: 1, maxLength: 4000 })
      }),
      execute: async (_id, params) => jsonResult(await execute("initialize_telegram_topic", "telegram.initializeTopic", params))
    }),
    defineTool({
      name: "send_artifact",
      label: "Send artifact",
      description: "Deliver an existing chat artifact to the current Telegram chat. Pass the `artifactId` returned by run_tool or from an inbound file. The delivery method and filename are derived from the artifact (its delivery hint, kind, and stored name); internal local paths are never exposed. No caption is shown by default, since the filename already appears on the attachment; set `caption` only to add a separate visible label, or `method` to override the delivery method. The artifact is not deleted.",
      parameters: Type.Object({
        artifactId: Type.String(),
        caption: Type.Optional(Type.String()),
        method: Type.Optional(Type.Union([
          Type.Literal("voice"),
          Type.Literal("audio"),
          Type.Literal("document")
        ]))
      }),
      execute: async (_id, params) => {
        const result = await execute("send_artifact", "artifacts.deliver", params);
        if (result?.ok === false) return jsonResult(result);
        return jsonResult({ ok: true, sent: result }, `Media sent to Telegram as ${result.method}.`);
      }
    })
  ];
}
