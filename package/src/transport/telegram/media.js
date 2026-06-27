async function downloadToBuffer(ctx, fileId) {
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function mimeTypeFromAudioFileName(fileName = "") {
  const extension = fileName.toLowerCase().split(".").pop();
  return {
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    mp4: "audio/mp4",
    mpeg: "audio/mpeg",
    mpga: "audio/mpga",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    wav: "audio/wav",
    webm: "audio/webm"
  }[extension] || "";
}

function normalizeDocumentMimeType(document) {
  const mimeType = document.mime_type || "";
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  return mimeTypeFromAudioFileName(document.file_name) || mimeType || "application/octet-stream";
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

  if (ctx.message?.audio) {
    const audio = ctx.message.audio;
    const fileName = audio.file_name || `${chatId}-${ctx.msg.message_id}`;
    const content = await downloadToBuffer(ctx, audio.file_id);
    return store.createGeneratedFile({
      fileName,
      content,
      kind: "audio",
      mimeType: audio.mime_type || "audio/mpeg",
      source: baseSource,
      metadata: {
        duration: audio.duration,
        performer: audio.performer,
        title: audio.title,
        fileSize: audio.file_size,
        ...incomingCaptionMetadata(ctx)
      }
    });
  }

  if (ctx.message?.video) {
    const video = ctx.message.video;
    const fileName = video.file_name || `${chatId}-${ctx.msg.message_id}.mp4`;
    const content = await downloadToBuffer(ctx, video.file_id);
    return store.createGeneratedFile({
      fileName,
      content,
      kind: "video",
      mimeType: video.mime_type || "video/mp4",
      source: baseSource,
      metadata: {
        duration: video.duration,
        width: video.width,
        height: video.height,
        fileSize: video.file_size,
        ...incomingCaptionMetadata(ctx)
      }
    });
  }

  if (ctx.message?.document) {
    const document = ctx.message.document;
    const fileName = document.file_name || `${chatId}-${ctx.msg.message_id}`;
    const mimeType = normalizeDocumentMimeType(document);
    const content = await downloadToBuffer(ctx, document.file_id);
    return store.createGeneratedFile({
      fileName,
      content,
      kind: mimeType.startsWith("audio/") ? "audio" : "document",
      mimeType,
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
      metadata: { visibility: "internal", representation: "inline-message" }
    });
  }

  return null;
}
