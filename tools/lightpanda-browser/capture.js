import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

export function decodeBoundedPng(result, config = {}) {
  const image = result?.content?.find((item) => item?.type === "image");
  if (!image || typeof image.data !== "string") throw new Error("Lightpanda screenshot returned no inline image.");
  const mimeType = String(image.mimeType || image.mime_type || "image/png").toLowerCase();
  if (mimeType !== "image/png") throw new Error(`Lightpanda screenshot returned unsupported type: ${mimeType}`);
  const maxBytes = boundedInteger(config.CAPTURE_MAX_BYTES, 1024 * 1024, 16 * 1024, 2 * 1024 * 1024);
  const approximateBytes = Math.floor(image.data.length * 0.75);
  if (approximateBytes > maxBytes + 3) throw new Error(`Lightpanda screenshot exceeds ${maxBytes} bytes.`);
  const buffer = Buffer.from(image.data, "base64");
  if (buffer.length > maxBytes) throw new Error(`Lightpanda screenshot exceeds ${maxBytes} bytes.`);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(pngSignature)) throw new Error("Lightpanda screenshot is not a valid PNG.");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const maxWidth = boundedInteger(config.CAPTURE_MAX_WIDTH, 1280, 320, 1280);
  const maxHeight = boundedInteger(config.CAPTURE_MAX_HEIGHT, 4096, 240, 4096);
  if (!width || !height || width > maxWidth || height > maxHeight) {
    throw new Error(`Lightpanda screenshot dimensions ${width}x${height} exceed ${maxWidth}x${maxHeight}.`);
  }
  return { buffer, width, height, bytes: buffer.length, mimeType };
}

export async function writeCapture(result, { tmpDir, config = {} }) {
  if (!path.isAbsolute(tmpDir)) throw new Error("Capture tmpDir must be absolute.");
  const capture = decodeBoundedPng(result, config);
  const directory = path.join(tmpDir, "captures");
  await mkdir(directory, { recursive: true });
  const fileName = `lightpanda-capture-${crypto.randomUUID()}.png`;
  const filePath = path.join(directory, fileName);
  await writeFile(filePath, capture.buffer, { flag: "wx", mode: 0o600 });
  return { ...capture, filePath, fileName };
}

export async function cleanupStaleCaptures(tmpDir, { olderThanMs = 10 * 60_000, now = Date.now() } = {}) {
  const directory = path.join(tmpDir, "captures");
  const names = await readdir(directory).catch(() => []);
  let removed = 0;
  for (const name of names) {
    if (!/^lightpanda-capture-[0-9a-f-]+\.png$/i.test(name)) continue;
    const filePath = path.join(directory, name);
    const info = await stat(filePath).catch(() => null);
    if (info && now - info.mtimeMs >= olderThanMs) {
      await unlink(filePath).catch(() => {});
      removed += 1;
    }
  }
  const remaining = await readdir(directory).catch(() => []);
  if (!remaining.length) {
    await rmdir(directory).catch(() => {});
    await rmdir(tmpDir).catch(() => {});
  }
  return removed;
}
