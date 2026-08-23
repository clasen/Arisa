import { findFirst } from "./magnific-api.js";

function clean(value) {
  return String(value ?? "").trim();
}

export function outputMime(value, fallback = "application/octet-stream") {
  const declared = clean(findFirst(value, ["mimeType", "mime_type", "contentType"])).split(";", 1)[0].toLowerCase();
  const received = clean(fallback).split(";", 1)[0].toLowerCase();
  const mime = [declared, received].find((candidate) => /^(?:image|audio|video)\//.test(candidate)) || "application/octet-stream";
  return mime === "audio/mp3" ? "audio/mpeg" : mime;
}

export function extension(mimeType) {
  return ({
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "video/mp4": ".mp4",
    "video/webm": ".webm"
  })[mimeType] || ".bin";
}

export function mediaKind(mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}
