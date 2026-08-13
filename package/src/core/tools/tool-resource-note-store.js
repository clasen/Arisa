import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getChatToolResourceNotesFile } from "../../runtime/paths.js";

export const maxToolResourceNoteCharacters = 200;

function emptyNotes() {
  return { version: 1, tools: {} };
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

async function readNotes(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed?.version === 1 && parsed.tools && typeof parsed.tools === "object"
      ? parsed
      : emptyNotes();
  } catch (error) {
    if (error?.code === "ENOENT") return emptyNotes();
    throw error;
  }
}

async function writeNotes(file, notes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(notes, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export class ToolResourceNoteStore {
  constructor({ resolveFile = getChatToolResourceNotesFile } = {}) {
    this.resolveFile = resolveFile;
    this.queues = new Map();
  }

  async get(chatId, toolName, resourceId) {
    if (chatId == null || !resourceId) return "";
    await (this.queues.get(String(chatId)) || Promise.resolve()).catch(() => {});
    const notes = await readNotes(this.resolveFile(chatId));
    return notes.tools?.[String(toolName)]?.[String(resourceId)]?.note || "";
  }

  async set(chatId, toolName, resourceId, note) {
    const scopedToolName = requiredText(toolName, "toolName");
    const scopedResourceId = requiredText(resourceId, "resourceId");
    const scopedNote = String(note ?? "").trim();
    if ([...scopedNote].length > maxToolResourceNoteCharacters) {
      throw new Error(`note must be at most ${maxToolResourceNoteCharacters} characters`);
    }
    const key = String(chatId);
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const file = this.resolveFile(chatId);
      const notes = await readNotes(file);
      notes.tools[scopedToolName] ||= {};
      if (scopedNote) {
        notes.tools[scopedToolName][scopedResourceId] = { note: scopedNote };
      } else {
        delete notes.tools[scopedToolName][scopedResourceId];
        if (!Object.keys(notes.tools[scopedToolName]).length) delete notes.tools[scopedToolName];
      }
      await writeNotes(file, notes);
    });
    this.queues.set(key, current);
    try {
      await current;
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
    return { ok: true, toolName: scopedToolName, resourceId: scopedResourceId, note: scopedNote };
  }
}
