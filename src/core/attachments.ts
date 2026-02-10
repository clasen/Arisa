/**
 * @module core/attachments
 * @role Persist media attachments so the model can access them later.
 * @responsibilities
 *   - Save base64 attachments to .tinyclaw/attachments/{chatId}/
 *   - Clean up files older than configured max age
 *   - Generate unique filenames with type prefix
 * @dependencies shared/config
 * @effects Disk I/O in .tinyclaw/attachments/
 */

import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync, rmdirSync } from "fs";
import { join } from "path";
import { config } from "../shared/config";
import { createLogger } from "../shared/logger";

const log = createLogger("core");

const EXT_MAP: Record<string, string> = {
  image: "jpg",
  audio: "ogg",
  document: "bin",
};

export function initAttachments(): void {
  if (!existsSync(config.attachmentsDir)) {
    mkdirSync(config.attachmentsDir, { recursive: true });
  }
  cleanupOldAttachments();
}

export function saveAttachment(
  chatId: string,
  type: "image" | "audio" | "document",
  base64: string,
  filename?: string,
): string {
  const chatDir = join(config.attachmentsDir, chatId);
  if (!existsSync(chatDir)) {
    mkdirSync(chatDir, { recursive: true });
  }

  const ext = filename ? filename.split(".").pop() || EXT_MAP[type] : EXT_MAP[type];
  const hex = Math.random().toString(16).slice(2, 6);
  const prefix = type === "image" ? "img" : type === "audio" ? "aud" : "doc";
  const outName = `${prefix}_${Date.now()}_${hex}.${ext}`;
  const outPath = join(chatDir, outName);

  const buffer = Buffer.from(base64, "base64");
  Bun.write(outPath, buffer);

  // Return path relative to project dir for model context
  const relPath = `.tinyclaw/attachments/${chatId}/${outName}`;
  log.info(`Saved ${type} attachment: ${relPath} (${buffer.length} bytes)`);
  return relPath;
}

function cleanupOldAttachments(): void {
  if (!existsSync(config.attachmentsDir)) return;

  const maxAge = config.attachmentMaxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let cleaned = 0;

  for (const chatId of readdirSync(config.attachmentsDir)) {
    const chatDir = join(config.attachmentsDir, chatId);
    if (!statSync(chatDir).isDirectory()) continue;

    for (const file of readdirSync(chatDir)) {
      const filePath = join(chatDir, file);
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > maxAge) {
        unlinkSync(filePath);
        cleaned++;
      }
    }

    // Remove empty chat dirs
    if (readdirSync(chatDir).length === 0) {
      rmdirSync(chatDir);
    }
  }

  if (cleaned > 0) {
    log.info(`Cleaned up ${cleaned} old attachment(s)`);
  }
}
