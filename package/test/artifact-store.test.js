import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const homeDir = await mkdtemp(path.join(os.tmpdir(), "arisa-artifact-store-home-"));
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;

const { ArtifactStore } = await import("../src/core/artifacts/artifact-store.js");
const { arisaHomeDir, getChatArtifactsIndexFile } = await import("../src/runtime/paths.js");

async function resetHome() {
  await rm(arisaHomeDir, { recursive: true, force: true });
}

test("creates, persists, reads, and lists text artifacts by recency", async () => {
  await resetHome();
  const store = new ArtifactStore();
  const chatStore = store.forChat("chat-1");

  const first = await chatStore.createText({
    text: "first",
    source: { type: "telegram" },
    metadata: { index: 1 }
  });
  const second = await chatStore.createText({
    text: "second",
    mimeType: "text/markdown",
    source: { type: "tool", toolName: "writer" },
    metadata: { index: 2 }
  });
  const third = await chatStore.createText({
    text: "third",
    source: { type: "tool", toolName: "writer" }
  });

  assert.equal(first.chatId, "chat-1");
  assert.equal(first.kind, "text");
  assert.equal(first.mimeType, "text/plain");
  assert.deepEqual(await chatStore.get(second.id), second);
  assert.deepEqual((await chatStore.listRecent(2)).map((artifact) => artifact.id), [third.id, second.id]);

  const reloadedStore = new ArtifactStore().forChat("chat-1");
  assert.deepEqual(await reloadedStore.get(first.id), first);
});

test("serializes 100 concurrent artifact writes across store instances", async () => {
  await resetHome();
  const chatId = "concurrent-chat";
  const stores = Array.from({ length: 5 }, () => new ArtifactStore().forChat(chatId));
  const artifacts = await Promise.all(Array.from({ length: 100 }, (_, index) => (
    stores[index % stores.length].createText({
      text: `message ${index}`,
      source: { type: "test", index }
    })
  )));

  const persisted = await new ArtifactStore().forChat(chatId).listRecent(100);
  assert.equal(persisted.length, 100);
  assert.equal(new Set(persisted.map((artifact) => artifact.id)).size, 100);
  assert.deepEqual(
    new Set(persisted.map((artifact) => artifact.id)),
    new Set(artifacts.map((artifact) => artifact.id))
  );
  const stateFiles = await readdir(path.dirname(getChatArtifactsIndexFile(chatId)));
  assert.equal(stateFiles.some((name) => name.endsWith(".tmp")), false);
});

test("refuses to overwrite a corrupt artifact index", async () => {
  await resetHome();
  const chatId = "corrupt-chat";
  const indexFile = getChatArtifactsIndexFile(chatId);
  await mkdir(path.dirname(indexFile), { recursive: true });
  await writeFile(indexFile, "{truncated", "utf8");

  await assert.rejects(
    new ArtifactStore().forChat(chatId).createText({ text: "must not replace", source: { type: "test" } }),
    /Artifact index is unreadable/
  );
  assert.equal(await readFile(indexFile, "utf8"), "{truncated");
});

test("copies file artifacts into the chat artifact directory", async () => {
  await resetHome();
  const originalDir = await mkdtemp(path.join(os.tmpdir(), "arisa-source-file-"));
  const originalPath = path.join(originalDir, "voice.ogg");
  await writeFile(originalPath, "audio-bytes", "utf8");

  const artifact = await new ArtifactStore().forChat("chat-1").createFromFile({
    originalPath,
    fileName: "voice.ogg",
    kind: "audio",
    mimeType: "audio/ogg",
    source: { type: "telegram", fileId: "telegram-file" },
    metadata: { duration: 3 }
  });

  assert.equal(artifact.chatId, "chat-1");
  assert.equal(artifact.kind, "audio");
  assert.equal(artifact.mimeType, "audio/ogg");
  assert.equal(path.basename(artifact.path), "voice.ogg");
  assert.equal(await readFile(artifact.path, "utf8"), "audio-bytes");
});

test("creates generated file artifacts", async () => {
  await resetHome();
  const artifact = await new ArtifactStore().forChat("chat-1").createGeneratedFile({
    fileName: "reply.md",
    content: "# Hello\n",
    kind: "document",
    mimeType: "text/markdown",
    source: { type: "assistant" }
  });

  assert.equal(await readFile(artifact.path, "utf8"), "\ufeff# Hello\n");
  assert.equal(artifact.kind, "document");
  assert.equal(artifact.mimeType, "text/markdown");
});

test("writes generated text file artifacts as BOM UTF-8", async () => {
  await resetHome();
  const content = "# Español\nÑandú\n";
  const artifact = await new ArtifactStore().forChat("chat-1").createGeneratedFile({
    fileName: "reply.txt",
    content,
    kind: "document",
    mimeType: "text/plain",
    source: { type: "assistant" }
  });

  assert.deepEqual(await readFile(artifact.path), Buffer.from(`\ufeff${content}`, "utf8"));
});

test("normalizes copied generated text files to BOM UTF-8", async () => {
  await resetHome();
  const originalDir = await mkdtemp(path.join(os.tmpdir(), "arisa-source-file-"));
  const originalPath = path.join(originalDir, "report.json");
  const content = "{\"message\":\"Español\"}\n";
  await writeFile(originalPath, content, "utf8");

  const artifact = await new ArtifactStore().forChat("chat-1").createFromFile({
    originalPath,
    fileName: "report.json",
    kind: "document",
    mimeType: "application/json",
    source: { type: "tool", toolName: "reporter" }
  });

  assert.deepEqual(await readFile(artifact.path), Buffer.from(`\ufeff${content}`, "utf8"));
  assert.equal(await readFile(originalPath, "utf8"), content);
});

test("does not duplicate an existing UTF-8 BOM", async () => {
  await resetHome();
  const originalDir = await mkdtemp(path.join(os.tmpdir(), "arisa-source-file-"));
  const originalPath = path.join(originalDir, "report.txt");
  const content = "\ufeffAlready marked\n";
  await writeFile(originalPath, content, "utf8");

  const artifact = await new ArtifactStore().forChat("chat-1").createFromFile({
    originalPath,
    fileName: "report.txt",
    kind: "document",
    mimeType: "text/plain",
    source: { type: "tool", toolName: "reporter" }
  });

  assert.deepEqual(await readFile(artifact.path), Buffer.from(content, "utf8"));
});

test("keeps artifact indexes isolated by chat", async () => {
  await resetHome();
  const store = new ArtifactStore();
  const chatA = store.forChat("chat-a");
  const chatB = store.forChat("chat-b");

  const aArtifact = await chatA.createText({ text: "for A", source: { type: "test" } });
  const bArtifact = await chatB.createText({ text: "for B", source: { type: "test" } });

  assert.deepEqual((await chatA.listRecent()).map((artifact) => artifact.id), [aArtifact.id]);
  assert.deepEqual((await chatB.listRecent()).map((artifact) => artifact.id), [bArtifact.id]);
  assert.equal(await chatA.get(bArtifact.id), null);
  assert.equal(await chatB.get(aArtifact.id), null);
});
