import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const delegateTaskToolName = "delegate_task";

const recentRunsKept = 20;

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid pi.subagents.${name}: ${String(value)}`);
  }
  return value;
}

function assistantText(message) {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

// Prompts the session and returns the text of its last assistant message: the subagent's report.
export async function promptForFinalText(session, prompt) {
  let finalText = "";
  let errorMessage = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    if (event.message.stopReason === "error") {
      errorMessage = event.message.errorMessage || "assistant message ended with error";
      return;
    }
    if (event.message.stopReason !== "aborted") errorMessage = "";
    const text = assistantText(event.message);
    if (text) finalText = text;
  });
  try {
    await session.prompt(prompt);
  } finally {
    unsubscribe();
  }
  if (errorMessage) throw new Error(errorMessage);
  return finalText;
}

export function buildDelegatedTaskPrompt(task) {
  return [
    "Delegated task from the main Arisa agent.",
    "You start without the chat history: everything you need is in the brief below or reachable with your tools.",
    "Complete the task, then reply with one final report for the main agent: what you did, the result, the paths or identifiers it needs, and anything left undone or unverified.",
    "Do not address the user and do not ask questions; if the brief is not actionable, report exactly what is missing.",
    "",
    "Brief:",
    task
  ].join("\n");
}

export function createDelegateTaskTool({ run }) {
  return defineTool({
    name: delegateTaskToolName,
    label: "Delegate task",
    description: [
      "Run a self-contained multi-step task in a subagent that starts with an empty context and the same tools, and get back only its final report.",
      "Every model call you make resends this whole conversation, so delegate work that needs more than about five tool calls and does not depend on the conversation: building or editing a tool, debugging, investigating files or logs, running and fixing tests, multi-step tool operations.",
      "Do not delegate quick lookups, single tool calls, or anything that needs back-and-forth with the user.",
      "The subagent knows nothing about this chat: write a complete brief with the goal, relevant paths, tool names, constraints, decisions already made, and what done looks like.",
      "One subagent runs at a time and it cannot delegate further. Review its report before answering the user."
    ].join(" "),
    parameters: Type.Object({
      task: Type.String({ minLength: 1, description: "Complete brief for the subagent." }),
      label: Type.String({ minLength: 1, maxLength: 80, description: "Short name of the task, used in logs and diagnostics." })
    }),
    execute: async (_id, params) => {
      const result = await run({ task: params.task, label: params.label });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  });
}

// Runs subagent sessions under explicit control: one run per parent chat, a model-call budget,
// a wall-clock deadline, cancellation, and a usage record for every run.
export class SubagentRunner {
  constructor({ config, logger }) {
    this.logger = logger;
    this.active = new Map();
    this.recent = [];
    this.setConfig(config);
  }

  setConfig(config) {
    this.limits = {
      maxModelCalls: assertPositiveInteger(config?.maxModelCalls, "maxModelCalls"),
      timeoutMs: assertPositiveInteger(config?.timeoutMs, "timeoutMs")
    };
  }

  async run({ parentKey, kind, label, openSession, execute }) {
    const key = String(parentKey);
    if (this.active.has(key)) {
      throw new Error(`A subagent is already running for chat ${key}: ${this.active.get(key).record.label}`);
    }
    const record = {
      id: randomUUID().slice(0, 8),
      parentKey: key,
      kind,
      label,
      status: "running",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      modelCalls: 0,
      tokens: { input: 0, cacheRead: 0, output: 0 },
      stopReason: null
    };
    const entry = { record, session: null, stop: null };
    this.active.set(key, entry);
    const startedAt = Date.now();
    let timer = null;
    let unsubscribe = null;
    try {
      this.logger?.log("agent", `subagent ${record.id} (${kind}) started for chat ${key}: ${label}`);
      const session = await openSession(record.id);
      entry.session = session;
      entry.stop = (reason) => {
        if (record.stopReason) return Promise.resolve();
        record.stopReason = reason;
        return Promise.resolve(session.abort?.()).catch((error) => {
          this.logger?.error?.("agent", `subagent ${record.id} abort failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      };
      if (record.stopReason) {
        record.status = "stopped";
        return this.result(record, "");
      }
      unsubscribe = session.subscribe((event) => {
        if (event.type !== "message_end" || event.message?.role !== "assistant") return;
        const usage = event.message.usage || {};
        record.modelCalls += 1;
        record.tokens.input += usage.input || 0;
        record.tokens.cacheRead += usage.cacheRead || 0;
        record.tokens.output += usage.output || 0;
        if (record.modelCalls >= this.limits.maxModelCalls && event.message.stopReason === "toolUse") {
          entry.stop("max_model_calls");
        }
      });
      timer = setTimeout(() => entry.stop("timeout"), this.limits.timeoutMs);
      timer.unref?.();

      const text = await execute(session);
      record.status = record.stopReason ? "stopped" : "completed";
      return this.result(record, text);
    } catch (error) {
      record.status = record.stopReason ? "stopped" : "failed";
      if (!record.stopReason) throw error;
      return this.result(record, "");
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      record.durationMs = Date.now() - startedAt;
      this.active.delete(key);
      this.recent.unshift(record);
      this.recent.length = Math.min(this.recent.length, recentRunsKept);
      this.logger?.log(
        "agent",
        `subagent ${record.id} (${kind}) ${record.status}${record.stopReason ? ` [${record.stopReason}]` : ""} for chat ${key}: `
        + `${record.modelCalls} model calls, ${record.tokens.input + record.tokens.cacheRead} input tokens, ${record.tokens.output} output tokens, ${record.durationMs}ms`
      );
      try {
        await (entry.session?.close?.() ?? entry.session?.dispose?.());
      } catch (error) {
        this.logger?.error?.("agent", `subagent ${record.id} close failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  result(record, text) {
    return {
      subagentId: record.id,
      status: record.status,
      ...(record.stopReason ? { stopReason: record.stopReason } : {}),
      report: text,
      modelCalls: record.modelCalls
    };
  }

  // Stops the run owned by a chat. A run that has not opened its session yet stops as soon as it does.
  async abort(parentKey, reason = "aborted") {
    const entry = this.active.get(String(parentKey));
    if (!entry) return false;
    if (entry.stop) await entry.stop(reason);
    else entry.record.stopReason = reason;
    return true;
  }

  async abortAll(reason = "shutdown") {
    await Promise.all([...this.active.keys()].map((key) => this.abort(key, reason)));
  }

  diagnostic() {
    return {
      limits: { ...this.limits },
      active: [...this.active.values()].map((entry) => ({ ...entry.record, tokens: { ...entry.record.tokens } })),
      recent: this.recent.map((record) => ({ ...record, tokens: { ...record.tokens } }))
    };
  }
}
