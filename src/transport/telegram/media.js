import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const inboxDir = path.resolve("data/inbox");

async function downloadToFile(ctx, fileId, fileName) {
  await mkdir(inboxDir, { recursive: true });
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const target = path.join(inboxDir, fileName);
  await writeFile(target, buffer);
  return target;
}

export async function captureIncomingArtifact(ctx, artifactStore) {
  const baseSource = {
    type: "telegram",
    chatId: ctx.chat.id,
    messageId: ctx.msg.message_id,
    userId: ctx.from.id
  };

  if (ctx.message?.voice) {
    const fileName = `${ctx.chat.id}-${ctx.msg.message_id}.ogg`;
    const tempPath = await downloadToFile(ctx, ctx.message.voice.file_id, fileName);
    return artifactStore.createFromFile({
      originalPath: tempPath,
      fileName,
      kind: "audio",
      mimeType: "audio/ogg",
      source: baseSource,
      metadata: { duration: ctx.message.voice.duration }
    });
  }

  if (ctx.message?.document) {
    const fileName = ctx.message.document.file_name || `${ctx.chat.id}-${ctx.msg.message_id}`;
    const tempPath = await downloadToFile(ctx, ctx.message.document.file_id, fileName);
    return artifactStore.createFromFile({
      originalPath: tempPath,
      fileName,
      kind: "document",
      mimeType: ctx.message.document.mime_type || "application/octet-stream",
      source: baseSource,
      metadata: {}
    });
  }

  if (ctx.message?.photo?.length) {
    const photo = ctx.message.photo.at(-1);
    const fileName = `${ctx.chat.id}-${ctx.msg.message_id}.jpg`;
    const tempPath = await downloadToFile(ctx, photo.file_id, fileName);
    return artifactStore.createFromFile({
      originalPath: tempPath,
      fileName,
      kind: "image",
      mimeType: "image/jpeg",
      source: baseSource,
      metadata: { width: photo.width, height: photo.height }
    });
  }

  if (ctx.message?.text) {
    return artifactStore.createText({
      text: ctx.message.text,
      source: baseSource,
      metadata: {}
    });
  }

  return null;
}
