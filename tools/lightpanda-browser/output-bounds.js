const minimumOutputBytes = 1024;
const maximumOutputBytes = 1024 * 1024;

export function normalizeMaxOutputBytes(value, fallback = 128 * 1024) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximumOutputBytes, Math.max(minimumOutputBytes, Math.floor(number)));
}

export function boundUtf8(text, maxBytes) {
  const value = String(text ?? "");
  const limit = normalizeMaxOutputBytes(maxBytes);
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return { text: value, bytes: bytes.length, truncated: false };

  const marker = "\n[output truncated]\n";
  const markerBytes = Buffer.byteLength(marker);
  const payloadLimit = Math.max(0, limit - markerBytes);
  let bounded = bytes.subarray(0, payloadLimit).toString("utf8");
  while (Buffer.byteLength(bounded, "utf8") > payloadLimit) bounded = bounded.slice(0, -1);
  const result = `${bounded}${marker}`;
  return { text: result, bytes: Buffer.byteLength(result), truncated: true };
}
