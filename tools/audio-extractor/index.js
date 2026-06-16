import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import defaults from "./config.js";
const toolName = "audio-extractor";

async function getArisaPackageDir() {
  if (process.env.ARISA_PACKAGE_DIR) return process.env.ARISA_PACKAGE_DIR;
  return (await readFile(path.join(os.homedir(), ".arisa", "arisa-package-dir"), "utf8")).trim();
}

async function importArisa(relativePath) {
  return import(pathToFileURL(path.join(await getArisaPackageDir(), relativePath)).href);
}

const { loadToolConfig } = await importArisa("src/core/tools/tool-config.js");
const { toolError, toolOk } = await importArisa("src/core/tools/tool-result.js");
const { getChatToolTmpDir, getToolConfigPath, getToolTmpDir } = await importArisa("src/runtime/paths.js");

function printHelp() {
  console.log(`audio-extractor\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nExpected input:\n  {\n    "artifact": { "path": "/abs/video.mp4", "mimeType": "video/mp4" },\n    "args": { "format": "wav|mp3", "sampleRate": "16000", "channels": "1" }\n  }\n\nOutput:\n  A generated audio artifact. Default is audio/wav normalized to 16 kHz mono, suitable for transcription. Use args.format=mp3 for audio/mpeg.\n\nConfig at ${getToolConfigPath(toolName)}:\n  FFMPEG_COMMAND (optional, default ffmpeg)\n  FFPROBE_COMMAND (optional, default ffprobe)\n`);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function outputFormat(request = {}) {
  const format = String(request.args?.format || request.format || "wav").toLowerCase();
  if (["mp3", "mpeg"].includes(format)) return "mp3";
  return "wav";
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function assertInput(filePath) {
  if (!filePath) throw new Error("artifact.path is required");
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`Input is not a file: ${filePath}`);
  if (info.size < 1024) throw new Error(`Input file is too small (${info.size} bytes)`);
}

async function assertHasAudio(command, filePath) {
  const result = await runProcess(command, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", filePath]);
  if (result.code !== 0) throw new Error(`ffprobe failed: ${result.stderr || result.stdout}`.trim());
  if (!result.stdout.split(/\s+/).includes("audio")) throw new Error("ffprobe did not detect an audio stream");
}

function buildFfmpegArgs(inputPath, outputPath, format, sampleRate, channels) {
  const base = ["-y", "-i", inputPath, "-vn", "-map", "0:a:0", "-ar", String(sampleRate), "-ac", String(channels)];
  if (format === "mp3") return [...base, "-codec:a", "libmp3lame", "-q:a", "2", outputPath];
  return [...base, "-codec:a", "pcm_s16le", outputPath];
}

async function extractAudio(request, config) {
  const inputPath = request.artifact?.path || request.filePath || request.args?.filePath;
  await assertInput(inputPath);
  await assertHasAudio(config.FFPROBE_COMMAND || "ffprobe", inputPath);

  const format = outputFormat(request);
  const sampleRate = positiveInteger(request.args?.sampleRate || request.sampleRate, 16000);
  const channels = positiveInteger(request.args?.channels || request.channels, 1);
  const chatId = request.chatId == null ? null : String(request.chatId);
  const tmpDir = chatId ? getChatToolTmpDir(chatId, toolName) : getToolTmpDir(toolName);
  await mkdir(tmpDir, { recursive: true });

  const id = crypto.randomBytes(5).toString("hex");
  const baseName = path.basename(inputPath, path.extname(inputPath)).replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80) || "audio";
  const fileName = `${baseName}_${Date.now()}_${id}.${format}`;
  const outputPath = path.join(tmpDir, fileName);
  const result = await runProcess(config.FFMPEG_COMMAND || "ffmpeg", buildFfmpegArgs(inputPath, outputPath, format, sampleRate, channels));
  if (result.code !== 0) throw new Error(`ffmpeg failed (exit ${result.code}). ${result.stderr || result.stdout}`.trim());
  await assertInput(outputPath);

  return {
    filePath: outputPath,
    fileName,
    kind: "audio",
    mimeType: format === "mp3" ? "audio/mpeg" : "audio/wav",
    text: `Extracted ${format.toUpperCase()} audio (${sampleRate} Hz, ${channels} channel${channels === 1 ? "" : "s"}) from ${path.basename(inputPath)}`
  };
}

async function main() {
  const [, , command, flag, requestFile] = process.argv;
  if (process.argv.includes("--help") || !command) {
    printHelp();
    return;
  }
  if (command !== "run" || flag !== "--request-file" || !requestFile) {
    console.log(JSON.stringify(toolError("Invalid usage. Run node index.js --help.")));
    return;
  }

  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    const config = await loadToolConfig(toolName, defaults, request.chatId);
    const output = await extractAudio(request, config);
    console.log(JSON.stringify(toolOk(output)));
  } catch (error) {
    console.log(JSON.stringify(toolError(error?.message || String(error))));
  }
}

main();
