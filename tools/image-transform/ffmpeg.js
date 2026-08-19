import { execFile } from "node:child_process";

const extensions = { jpeg: "jpg", png: "png", webp: "webp" };
const mimeTypes = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export function outputMetadata(format) {
  return { extension: extensions[format], mimeType: mimeTypes[format] };
}

export async function runFfmpeg({ sourcePath, outputPath, filters, format, quality }) {
  const args = ["-y", "-i", sourcePath];
  if (filters.length) args.push("-vf", filters.join(","));
  if (format === "jpeg" || format === "webp") {
    const qscale = Math.max(2, Math.min(31, Math.round(31 - quality * 0.29)));
    args.push("-q:v", String(qscale));
  } else if (format === "png") args.push("-compression_level", "6");
  args.push(outputPath);
  await new Promise((resolve, reject) => {
    execFile("ffmpeg", args, (error, _stdout, stderr) => {
      if (error) reject(new Error(`Image transformation failed: ${String(stderr || error.message).trim().split("\n").at(-1)}`));
      else resolve();
    });
  });
}
