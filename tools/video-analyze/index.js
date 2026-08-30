import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import defaults from "./config.js";

const toolName = "video-analyze";
const packageDir = process.env.ARISA_PACKAGE_DIR || (await readFile(path.join(os.homedir(), ".arisa", "arisa-package-dir"), "utf8")).trim();
const core = (relative) => import(pathToFileURL(path.join(packageDir, relative)).href);
const { loadToolConfig } = await core("src/core/tools/tool-config.js");
const { toolOk, toolError } = await core("src/core/tools/tool-result.js");
const { getChatToolTmpDir, getToolTmpDir, getToolConfigPath } = await core("src/runtime/paths.js");

function help() {
  console.log(`video-analyze\n\nUsage:\n  node index.js run --request-file <json>\n\nInput: a video artifact. Optional args: frames (default 12), columns (default 4), width (default 320).\nOutput: a timestamped JPEG contact sheet with timing metadata in the tool result.\nFor a transcript, run audio-extractor on the original video, then a transcription tool on the audio artifact.\n\nConfig: ${getToolConfigPath(toolName)}`);
}
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => resolve({ code: 127, out, err: e.message })); child.on("close", (code) => resolve({ code, out, err }));
  });
}
function integer(value, fallback, minimum = 1) { const n = Number.parseInt(value, 10); return Number.isFinite(n) && n >= minimum ? n : fallback; }
function safeBase(file) { return path.basename(file, path.extname(file)).replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80) || "video"; }
async function durationOf(file, ffprobe) {
  const result = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
  const seconds = Number.parseFloat(result.out); if (result.code || !Number.isFinite(seconds) || seconds <= 0) throw new Error(`Could not read video duration: ${result.err || result.out}`);
  return seconds;
}
async function analyze(request, config) {
  const input = request.artifact?.path || request.args?.filePath;
  if (!input) throw new Error("A video artifact is required.");
  if (!(await stat(input)).isFile()) throw new Error("Input must be a file.");
  const frames = integer(request.args?.frames, integer(config.DEFAULT_FRAMES, 12), 2);
  const columns = integer(request.args?.columns, integer(config.GRID_COLUMNS, 4), 1);
  const width = integer(request.args?.width, integer(config.THUMBNAIL_WIDTH, 320), 64);
  const duration = await durationOf(input, config.FFPROBE_COMMAND || "ffprobe");
  const rows = Math.ceil(frames / columns); const fps = frames / duration;
  const chatId = request.chatId == null ? null : String(request.chatId);
  const dir = chatId ? getChatToolTmpDir(chatId, toolName) : getToolTmpDir(toolName);
  await mkdir(dir, { recursive: true });
  const id = crypto.randomBytes(5).toString("hex"); const base = `${safeBase(input)}-grid-${id}`;
  const grid = path.join(dir, `${base}.jpg`);
  const timestamp = "drawtext=text='%{pts\\:hms}':x=8:y=h-th-8:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.65";
  const filter = `fps=${fps},scale=${width}:-2:force_original_aspect_ratio=decrease,pad=${width}:trunc(ow/a/2)*2:(ow-iw)/2:(oh-ih)/2,${timestamp},tile=${columns}x${rows}:padding=4:margin=4`;
  const result = await run(config.FFMPEG_COMMAND || "ffmpeg", ["-y", "-i", input, "-vf", filter, "-frames:v", "1", "-q:v", "3", grid]);
  if (result.code) throw new Error(`ffmpeg failed: ${result.err || result.out}`.trim());
  const timestamps = Array.from({ length: frames }, (_, i) => Number(((i * duration) / frames).toFixed(3)));
  const metadata = {
    source: path.basename(input),
    durationSeconds: Number(duration.toFixed(3)),
    frames,
    columns,
    rows,
    timestampsSeconds: timestamps,
    transcription: "Run audio-extractor on the source video, then openai-transcribe or whispermix-transcribe on its audio artifact."
  };
  return toolOk({
    filePath: grid,
    fileName: `${base}.jpg`,
    kind: "image",
    mimeType: "image/jpeg",
    text: `Created a timestamped ${frames}-frame ${columns}x${rows} contact sheet for ${path.basename(input)}.`,
    json: metadata
  });
}
async function main() {
  const [, , command, flag, requestFile] = process.argv;
  if (process.argv.includes("--help") || !command) return help();
  if (command !== "run" || flag !== "--request-file" || !requestFile) return console.log(JSON.stringify(toolError("Invalid usage. Run node index.js --help.")));
  try { const request = JSON.parse(await readFile(requestFile, "utf8")); const config = await loadToolConfig(toolName, defaults, request.chatId); console.log(JSON.stringify(await analyze(request, config))); }
  catch (error) { console.log(JSON.stringify(toolError(error?.message || String(error)))); }
}
main();
