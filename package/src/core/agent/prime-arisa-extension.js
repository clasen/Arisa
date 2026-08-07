import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";

async function readOptionalFile(file) {
  if (!file) return "";
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function createClient() {
  const packageDir = process.env.ARISA_PACKAGE_DIR;
  const chatId = process.env.ARISA_CHAT_ID;
  if (!packageDir || !chatId) {
    throw new Error("Arisa bridge requires ARISA_PACKAGE_DIR and ARISA_CHAT_ID");
  }
  const clientModule = await import(pathToFileURL(path.join(packageDir, "src", "core", "tools", "ipc-client.js")).href);
  return clientModule.createArisaClient({
    toolName: "prime-agent-bridge",
    chatId,
    capabilityToken: process.env.ARISA_IPC_TOKEN
  });
}

function asToolResult(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    details: value
  };
}

export default function arisaPrimeExtension(pi) {
  let clientPromise;
  const client = () => (clientPromise ||= createClient());

  pi.on("before_agent_start", async (event) => {
    const sections = [];
    for (const [label, file] of [
      ["Arisa operating instructions", process.env.ARISA_AGENTS_FILE],
      ["Arisa runtime context", process.env.ARISA_RUNTIME_CONTEXT_FILE],
      ["Safe session handoff", process.env.ARISA_HANDOFF_FILE]
    ]) {
      const content = await readOptionalFile(file);
      if (content) sections.push(`${label}:\n${content}`);
    }
    if (!sections.length) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${sections.join("\n\n")}` };
  });

  pi.registerTool({
    name: "list_tools",
    label: "List Arisa tools",
    description: "List Arisa modular tools with capabilities, daemon health, and recommended disposition.",
    parameters: Type.Object({}),
    async execute() {
      return asToolResult(await (await client()).tools.list());
    }
  });

  pi.registerTool({
    name: "tool_help",
    label: "Arisa tool help",
    description: "Show the CLI help for an Arisa modular tool.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params) {
      return asToolResult(await (await client()).tools.help({ name: params.name }));
    }
  });

  pi.registerTool({
    name: "tool_skills",
    label: "Arisa tool skills",
    description: "Show resolved skill hints for an Arisa modular tool.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params) {
      return asToolResult(await (await client()).tools.skills({ name: params.name }));
    }
  });

  pi.registerTool({
    name: "set_tool_config",
    label: "Set Arisa tool config",
    description: "Set one chat-scoped configuration value for an Arisa tool.",
    parameters: Type.Object({ name: Type.String(), field: Type.String(), value: Type.String() }),
    async execute(_id, params) {
      return asToolResult(await (await client()).tools.setConfig(params));
    }
  });

  pi.registerTool({
    name: "run_tool",
    label: "Run Arisa tool",
    description: "Run an Arisa modular CLI tool. Set deliver true only when its output artifact should be sent to Telegram now.",
    parameters: Type.Object({
      name: Type.String(),
      artifactId: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      args: Type.Optional(Type.Record(Type.String(), Type.String())),
      deliver: Type.Optional(Type.Boolean())
    }),
    async execute(_id, params) {
      const arisa = await client();
      const result = await arisa.tools.run(params, { timeoutMs: 24 * 60 * 60 * 1000 });
      if (params.deliver && result.output?.artifactId) {
        result.sent = await arisa.artifacts.deliver({ artifactId: result.output.artifactId });
      }
      return asToolResult(result);
    }
  });

  pi.registerTool({
    name: "list_scheduled_tasks",
    label: "List Arisa tasks",
    description: "List scheduled Arisa tasks for the current Telegram chat.",
    parameters: Type.Object({ status: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      return asToolResult(await (await client()).tasks.list(params));
    }
  });

  pi.registerTool({
    name: "cancel_scheduled_task",
    label: "Cancel Arisa task",
    description: "Cancel one scheduled Arisa task by id.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      return asToolResult(await (await client()).tasks.cancel({ taskId: params.id }));
    }
  });

  pi.registerTool({
    name: "cancel_all_scheduled_tasks",
    label: "Cancel all Arisa tasks",
    description: "Cancel all pending or running scheduled tasks for the current Telegram chat.",
    parameters: Type.Object({}),
    async execute() {
      return asToolResult(await (await client()).tasks.cancelAll());
    }
  });

  pi.registerTool({
    name: "send_artifact",
    label: "Send Arisa artifact",
    description: "Deliver an existing artifact belonging to this Telegram chat.",
    parameters: Type.Object({
      artifactId: Type.String(),
      caption: Type.Optional(Type.String()),
      method: Type.Optional(Type.Union([
        Type.Literal("voice"),
        Type.Literal("audio"),
        Type.Literal("document"),
        Type.Literal("photo"),
        Type.Literal("video")
      ]))
    }),
    async execute(_id, params) {
      return asToolResult(await (await client()).artifacts.deliver(params));
    }
  });
}
