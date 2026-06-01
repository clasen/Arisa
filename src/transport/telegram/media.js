async function downloadToBuffer(ctx, fileId) {
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function incomingCaptionMetadata(ctx) {
  return ctx.message?.caption ? { caption: ctx.message.caption } : {};
}

export async function captureIncomingArtifact(ctx, artifactStore) {
  const chatId = ctx.chat.id;
  const store = artifactStore.forChat(chatId);
  const baseSource = {
    type: "telegram",
    chatId,
    messageId: ctx.msg.message_id,
    userId: ctx.from.id
  };

  if (ctx.message?.voice) {
    const fileName = `${chatId}-${ctx.msg.message_id}.ogg`;
    const content = await downloadToBuffer(ctx, ctx.message.voice.file_id);
    return store.createGeneratedFile({
      fileName,
      content,
      kind: "audio",
      mimeType: "audio/ogg",
      source: baseSource,
      metadata: { duration: ctx.message.voice.duration, ...incomingCaptionMetadata(ctx) }
    });
  }

  if (ctx.message?.document) {
    const fileName = ctx.message.document.file_name || `${chatId}-${ctx.msg.message_id}`;
    const content = await downloadToBuffer(ctx, ctx.message.document.file_id);
    return store.createGeneratedFile({
      fileName,
      content,
      kind: "document",
      mimeType: ctx.message.document.mime_type || "application/octet-stream",
      source: baseSource,
      metadata: incomingCaptionMetadata(ctx)
    });
  }

  if (ctx.message?.photo?.length) {
    const photo = ctx.message.photo.at(-1);
    const fileName = `${chatId}-${ctx.msg.message_id}.jpg`;
    const content = await downloadToBuffer(ctx, photo.file_id);
    return store.createGeneratedFile({
      fileName,
      content,
      kind: "image",
      mimeType: "image/jpeg",
      source: baseSource,
      metadata: { width: photo.width, height: photo.height, ...incomingCaptionMetadata(ctx) }
    });
  }

  if (ctx.message?.text) {
    return store.createText({
      text: ctx.message.text,
      source: baseSource,
      metadata: {}
    });
  }

  return null;
}
