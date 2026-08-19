import { execFile } from "node:child_process";

function boundedNumber(value, fallback, min, max, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

export function cropOptions(args = {}) {
  return {
    zoom: boundedNumber(args.zoom, 1, 1, 8, "zoom"),
    focusX: boundedNumber(args.focusX, 0.5, 0, 1, "focusX"),
    focusY: boundedNumber(args.focusY, 0.5, 0, 1, "focusY"),
    size: Math.round(boundedNumber(args.size, 1024, 64, 4096, "size")),
    quality: Math.round(boundedNumber(args.quality, 2, 2, 31, "quality"))
  };
}

export function buildSquareZoomFilter(options) {
  const side = `min(iw\\,ih)/${options.zoom}`;
  return `crop=${side}:${side}:(iw-${side})*${options.focusX}:(ih-${side})*${options.focusY},scale=${options.size}:${options.size}`;
}

export async function cropImage({ sourcePath, outputPath, args = {} }) {
  const options = cropOptions(args);
  const filter = buildSquareZoomFilter(options);
  await new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", "-i", sourcePath, "-vf", filter, "-q:v", String(options.quality), outputPath], (error, _stdout, stderr) => {
      if (error) reject(new Error(`Image crop failed: ${String(stderr || error.message).trim().split("\n").at(-1)}`));
      else resolve();
    });
  });
  return { outputPath, options };
}
