import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getChatToolUsageFile } from "../../platform/paths.js";

function emptyUsage() {
  return { version: 1, tools: {} };
}

async function readUsage(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed?.version === 1 && parsed.tools && typeof parsed.tools === "object"
      ? parsed
      : emptyUsage();
  } catch (error) {
    if (error?.code === "ENOENT") return emptyUsage();
    throw error;
  }
}

async function writeUsage(file, usage) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(usage, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export class ToolUsageStore {
  constructor({ resolveFile = getChatToolUsageFile } = {}) {
    this.resolveFile = resolveFile;
    this.queues = new Map();
  }

  async record(chatId, toolName) {
    if (chatId == null || chatId === "") return;
    const key = String(chatId);
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const file = this.resolveFile(chatId);
      const usage = await readUsage(file);
      const count = Number(usage.tools[toolName]?.count) || 0;
      usage.tools[toolName] = { count: count + 1 };
      await writeUsage(file, usage);
    });
    this.queues.set(key, current);
    try {
      await current;
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }

  async counts(chatId) {
    if (chatId == null || chatId === "") return {};
    await (this.queues.get(String(chatId)) || Promise.resolve()).catch(() => {});
    const usage = await readUsage(this.resolveFile(chatId));
    return Object.fromEntries(Object.entries(usage.tools).map(([name, value]) => [name, Number(value?.count) || 0]));
  }
}
