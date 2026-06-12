import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import defaults from "./config.js";
import { loadToolConfig } from "../../src/core/tools/tool-config.js";
import { toolError, toolNeedsConfig, toolOk } from "../../src/core/tools/tool-result.js";
import { getToolConfigPath } from "../../src/runtime/paths.js";

const toolName = "openai-transcribe";
const config = await loadToolConfig(toolName, defaults);

const supportedUploadExtensions = new Set([
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".ogg",
  ".wav",
  ".webm"
]);

const mimeUploadExtensions = new Map([
  ["audio/aac", ".m4a"],
  ["audio/flac", ".flac"],
  ["audio/m4a", ".m4a"],
  ["audio/mp3", ".mp3"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/mpga", ".mpga"],
  ["audio/ogg", ".ogg"],
  ["audio/opus", ".ogg"],
  ["audio/wav", ".wav"],
  ["audio/wave", ".wav"],
  ["audio/webm", ".webm"],
  ["audio/x-m4a", ".m4a"],
  ["audio/x-wav", ".wav"],
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"]
]);

function baseMimeType(mimeType = "") {
  return mimeType.split(";")[0].trim().toLowerCase();
}

function uploadFileNameForArtifact(artifact) {
  const currentName = path.basename(artifact.path);
  const currentExtension = path.extname(currentName).toLowerCase();
  if (supportedUploadExtensions.has(currentExtension)) return currentName;

  const extension = mimeUploadExtensions.get(baseMimeType(artifact.mimeType));
  if (!extension) return currentName;

  const parsed = path.parse(currentName);
  return `${parsed.name || "audio"}${extension}`;
}

function printHelp() {
  console.log(`openai-transcribe\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nExpected input:\n  {\n    "artifact": { "path": "/abs/media.ogg", "mimeType": "audio/ogg" },\n    "args": {}\n  }\n\nSupported upload formats include flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, and webm.\n\nConfig at ${getToolConfigPath(toolName)}:\n  OPENAI_API_KEY\n  MODEL\n`);
}

async function run(requestFile) {
  if (!config.OPENAI_API_KEY) {
    console.log(JSON.stringify(toolNeedsConfig({
      tool: toolName,
      missingConfig: ["OPENAI_API_KEY"],
      configPath: getToolConfigPath(toolName)
    })));
    return;
  }

  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const artifact = request.artifact;
  if (!artifact?.path) {
    console.log(JSON.stringify(toolError("artifact.path is required")));
    return;
  }

  await stat(artifact.path);
  const form = new FormData();
  const data = await readFile(artifact.path);
  form.append("file", new Blob([data], { type: baseMimeType(artifact.mimeType) || "application/octet-stream" }), uploadFileNameForArtifact(artifact));
  form.append("model", config.MODEL);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
    body: form
  });

  const payload = await response.json();
  if (!response.ok) {
    console.log(JSON.stringify(toolError(payload.error?.message || "OpenAI transcription failed")));
    return;
  }

  console.log(JSON.stringify(toolOk({ text: payload.text || "" })));
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args[0] === "help") {
  printHelp();
} else if (args[0] === "run") {
  const fileIndex = args.indexOf("--request-file");
  await run(args[fileIndex + 1]);
} else {
  printHelp();
}
