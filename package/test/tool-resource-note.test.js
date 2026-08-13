import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolResourceNoteStore } from "../src/core/tools/tool-resource-note-store.js";
import { buildAsyncTaskPrompt } from "../src/transport/telegram/bot.js";

const root = await mkdtemp(path.join(os.tmpdir(), "arisa-resource-notes-"));
const resolveFile = (chatId) => path.join(root, String(chatId), "notes.json");

test.after(async () => rm(root, { recursive: true, force: true }));

test("stores short notes by chat, tool, and exact resource", async () => {
  const store = new ToolResourceNoteStore({ resolveFile });
  await store.set("chat-a", "whatsapp-web", "group@g.us", "They call me Peter.");
  assert.equal(await store.get("chat-a", "whatsapp-web", "group@g.us"), "They call me Peter.");
  assert.equal(await store.get("chat-b", "whatsapp-web", "group@g.us"), "");
  assert.equal(await store.get("chat-a", "other-tool", "group@g.us"), "");
  const persisted = JSON.parse(await readFile(resolveFile("chat-a"), "utf8"));
  assert.equal(persisted.tools["whatsapp-web"]["group@g.us"].note, "They call me Peter.");
});

test("enforces the 200-character limit and clears empty notes", async () => {
  const store = new ToolResourceNoteStore({ resolveFile });
  await assert.rejects(
    () => store.set("chat-a", "whatsapp-web", "other@g.us", "x".repeat(201)),
    /at most 200 characters/
  );
  await store.set("chat-a", "whatsapp-web", "other@g.us", "temporary");
  await store.set("chat-a", "whatsapp-web", "other@g.us", "");
  assert.equal(await store.get("chat-a", "whatsapp-web", "other@g.us"), "");
});

test("injects a matching resource note before scheduled event text", async () => {
  const store = new ToolResourceNoteStore({ resolveFile });
  await store.set("chat-a", "whatsapp-web", "group@g.us", "They call me Peter.");
  const prompt = await buildAsyncTaskPrompt({
    task: {
      id: "task-1",
      payload: { chatId: "chat-a", prompt: "Incoming WhatsApp message." },
      source: { toolName: "whatsapp-web", resourceId: "group@g.us" }
    },
    artifactStore: { forChat: () => ({ get: async () => null }) },
    toolRegistry: {},
    resourceNotes: store
  });
  assert.match(prompt, /resourceNote: They call me Peter\./);
  assert.ok(prompt.indexOf("resourceNote:") < prompt.indexOf("text: Incoming"));
});
