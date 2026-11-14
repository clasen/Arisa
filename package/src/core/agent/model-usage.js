import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getChatModelUsageFile } from "../../platform/paths.js";

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid pi.usage.${name}: ${String(value)}`);
  }
  return value;
}

async function readRuns(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed?.version === 1 && Array.isArray(parsed.runs) ? parsed.runs : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeRuns(file, runs) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, runs })}\n`, "utf8");
  await rename(temporary, file);
}

// Per-chat record of what each agent run cost. Runs older than the window are dropped on write.
export class ModelUsageStore {
  constructor({ config, resolveFile = getChatModelUsageFile, now = Date.now }) {
    this.resolveFile = resolveFile;
    this.now = now;
    this.queues = new Map();
    this.setConfig(config);
  }

  setConfig(config) {
    this.windowMs = assertPositiveInteger(config?.windowMs, "windowMs");
  }

  recent(runs) {
    const since = this.now() - this.windowMs;
    return runs.filter((run) => Date.parse(run.at) >= since);
  }

  async record(chatId, run) {
    const key = String(chatId);
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const file = this.resolveFile(chatId);
      await writeRuns(file, [...this.recent(await readRuns(file)), run]);
    });
    this.queues.set(key, current);
    try {
      await current;
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }

  async list(chatId) {
    await (this.queues.get(String(chatId)) || Promise.resolve()).catch(() => {});
    return this.recent(await readRuns(this.resolveFile(chatId)));
  }
}

// Default trigger description for callers that do not know the transport's prompt formats.
export function describePromptByFirstLine(prompt) {
  return { kind: "other", detail: String(prompt || "").split("\n", 1)[0].trim() };
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

// Records one usage run per agent run of the session: what triggered it and what its model calls cost.
// A fixed `trigger` names runs whose prompt does not describe them, such as delegated tasks.
export function trackModelUsage(session, { store, chatId, getSpeed, describePrompt, trigger = null, now = Date.now, logger }) {
  let lastTrigger = trigger;
  let run = null;
  const flush = () => {
    const finished = run;
    run = null;
    if (!finished?.modelCalls) return;
    store.record(chatId, finished).catch((error) => {
      logger?.error?.("agent", `could not record model usage for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const open = () => {
    run = {
      at: new Date(now()).toISOString(),
      kind: lastTrigger.kind,
      detail: lastTrigger.detail,
      model: "",
      speed: 1,
      modelCalls: 0,
      input: 0,
      cacheRead: 0,
      output: 0
    };
  };
  return session.subscribe((event) => {
    if (event.type === "agent_end") {
      flush();
      return;
    }
    if (event.type !== "message_end") return;
    if (event.message?.role === "user") {
      if (run) return;
      lastTrigger = trigger || describePrompt(messageText(event.message));
      open();
      return;
    }
    if (event.message?.role !== "assistant") return;
    if (!run) {
      if (!lastTrigger) return;
      open();
    }
    const usage = event.message.usage || {};
    run.model = event.message.model || run.model;
    run.speed = getSpeed();
    run.modelCalls += 1;
    run.input += usage.input || 0;
    run.cacheRead += usage.cacheRead || 0;
    run.output += usage.output || 0;
  });
}
