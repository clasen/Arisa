import path from "node:path";
import { unlink } from "node:fs/promises";

export async function materializeToolOutput({ result, name, chatId, artifactStore, taskStore, taskContext = null }) {
  const chatArtifactStore = artifactStore.forChat(chatId);

  if (result.output?.text) {
    const artifact = await chatArtifactStore.createText({
      text: result.output.text,
      source: { type: "tool", toolName: name },
      metadata: { tool: name }
    });
    result.output.artifactId = artifact.id;
  }

  if (result.output?.filePath) {
    const generated = await chatArtifactStore.createFromFile({
      originalPath: result.output.filePath,
      fileName: result.output.fileName || path.basename(result.output.filePath),
      kind: result.output.kind || "file",
      mimeType: result.output.mimeType || "application/octet-stream",
      source: { type: "tool", toolName: name },
      metadata: { tool: name, delivery: result.output.delivery }
    });
    result.output.artifactId = generated.id;
    await unlink(result.output.filePath).catch(() => {});
  }

  if (result.asyncTask || result.asyncTasks?.length) {
    result.asyncTasks = await taskStore.addMany(result.asyncTasks || [result.asyncTask], {
      payload: {
        chatId,
        ...(taskContext ? { telegramContext: taskContext } : {})
      },
      source: { type: "tool", toolName: name, chatId }
    });
    delete result.asyncTask;
  }

  return result;
}
