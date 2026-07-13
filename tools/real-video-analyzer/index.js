import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import defaults from "./config.js";

const toolName = "real-video-analyzer";
const toolDir = path.dirname(new URL(import.meta.url).pathname);
const bundledPythonDir = path.join(toolDir, "python");

const importCore = (relativePath) => import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, "src", relativePath)).href);
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { toolOk, toolError } = await importCore("core/tools/tool-result.js");
const { getChatToolTmpDir, getToolTmpDir } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`real-video-analyzer

Usage:
  node index.js --help
  node index.js run --request-file <json>

Input:
  artifact.path: local video file
  text: public video URL supported by yt-dlp

Options:
  args.maxFrames: maximum scene-aware keyframes (default 150)
  args.language: subtitle/Whisper language hint, e.g. en or es
  args.transcribe: false to skip transcript extraction
  args.sourceArtifactId: original video artifact id, enabling the audio-extractor -> whispermix-transcribe pipe
  args.adaptive: true to catch slow visual changes
  args.textAnchors: true to keep subtitle-timed frames

Output:
  A ZIP containing scene-aware deduplicated keyframes, transcript data when
  available, grids, MANIFEST.txt, and viewer.html. The returned text includes
  the manifest and transcript excerpt for the agent to interpret.
`);
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function validUrl(value) {
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

async function localVideoPath(request) {
  const filePath = request.artifact?.path || request.filePath || request.args?.filePath;
  if (!filePath) return "";
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("Input artifact is not a file");
  return filePath;
}

async function inputSource(request) {
  const filePath = await localVideoPath(request);
  if (filePath) return filePath;
  const url = validUrl(request.text || request.artifact?.text || request.args?.url);
  if (url) return url;
  throw new Error("Provide a video artifact or a public video URL in text.");
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readOptional(filePath, limit = 24_000) {
  try {
    return (await readFile(filePath, "utf8")).slice(0, limit).trim();
  } catch {
    return "";
  }
}

function outputArtifactId(result) {
  return result?.output?.artifactId || result?.artifactId || "";
}

function outputText(result) {
  return result?.output?.text || result?.text || "";
}

async function transcribeWithInstalledTools(request) {
  const sourceArtifactId = request.args?.sourceArtifactId || request.artifact?.id || request.artifact?.artifactId || request.artifactId;
  if (!sourceArtifactId || request.args?.transcribe === false || request.args?.transcribe === "false") return "";
  try {
    const { createArisaClient } = await importCore("core/tools/ipc-client.js");
    const arisa = createArisaClient({ toolName, chatId: request.chatId });
    const audio = await arisa.tools.run({
      name: "audio-extractor",
      artifactId: sourceArtifactId,
      args: { format: "wav", sampleRate: "16000", channels: "1" }
    }, { timeoutMs: 120_000 });
    const audioArtifactId = outputArtifactId(audio);
    if (!audioArtifactId) return "";
    const transcript = await arisa.tools.run({
      name: "whispermix-transcribe",
      artifactId: audioArtifactId,
      args: { language: request.args?.language || "auto" }
    }, { timeoutMs: 300_000 });
    return outputText(transcript).trim();
  } catch {
    return "";
  }
}

function crvCommand(config) {
  if (config.CRV_COMMAND) return String(config.CRV_COMMAND);
  return config.PYTHON_COMMAND || "python3";
}

function crvArgs(config, source, outputDir, request) {
  const commandIsPython = !config.CRV_COMMAND;
  const args = commandIsPython
    ? ["-m", "claude_real_video", source, "-o", outputDir]
    : [source, "-o", outputDir];
  args.push("--overwrite", "--grid", "--viewer", "--max-frames", String(positiveInteger(request.args?.maxFrames || config.MAX_FRAMES, 150)));
  if (request.args?.adaptive === true || request.args?.adaptive === "true") args.push("--adaptive");
  if (request.args?.textAnchors === true || request.args?.textAnchors === "true") args.push("--text-anchors");
  if (request.args?.transcribe === false || request.args?.transcribe === "false") args.push("--no-transcribe");
  if (request.args?.language) args.push("--lang", String(request.args.language));
  if (config.WHISPER_MODEL && !(request.args?.transcribe === false || request.args?.transcribe === "false")) args.push("--whisper-model", String(config.WHISPER_MODEL));
  return args;
}

async function analyze(request, config) {
  const source = await inputSource(request);
  const chatId = request.chatId == null ? "" : String(request.chatId);
  const tmpDir = chatId ? getChatToolTmpDir(chatId, toolName) : getToolTmpDir(toolName);
  await mkdir(tmpDir, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const outputDir = path.join(tmpDir, `analysis-${id}`);
  const zipPath = path.join(tmpDir, `video-analysis-${id}.zip`);
  await mkdir(outputDir, { recursive: true });

  const env = { ...process.env, PYTHONPATH: `${bundledPythonDir}${path.delimiter}${process.env.PYTHONPATH || ""}` };
  const result = await run(crvCommand(config), crvArgs(config, source, outputDir, request), { env });
  if (result.code !== 0) {
    await rm(outputDir, { recursive: true, force: true });
    throw new Error(`claude-real-video processing failed. ${result.stderr || result.stdout}`.trim());
  }

  const zip = await run("zip", ["-rq", zipPath, "."], { cwd: outputDir });
  if (zip.code !== 0) throw new Error(`Could not package analysis: ${zip.stderr || zip.stdout}`.trim());
  const manifest = await readOptional(path.join(outputDir, "MANIFEST.txt"));
  const crvTranscript = await readOptional(path.join(outputDir, "transcript.txt"));
  const transcript = crvTranscript || await transcribeWithInstalledTools(request);
  const frameCount = (manifest.match(/(?:kept|frames)\D+(\d+)/i) || [])[1] || "unknown";

  return {
    filePath: zipPath,
    fileName: path.basename(zipPath),
    kind: "document",
    mimeType: "application/zip",
    text: [
      `Prepared scene-aware video evidence (${frameCount} keyframes reported).`,
      manifest ? `\nMANIFEST.txt\n${manifest}` : "",
      transcript ? `\nTranscript excerpt\n${transcript}` : ""
    ].join("\n").trim(),
    metadata: { source, outputDir, technique: "claude-real-video scene detection + dedup" }
  };
}

async function main() {
  const [, , command, flag, requestFile] = process.argv;
  if (!command || process.argv.includes("--help") || command === "help") return printHelp();
  if (command !== "run" || flag !== "--request-file" || !requestFile) {
    console.log(JSON.stringify(toolError("Invalid usage. Run node index.js --help.")));
    return;
  }
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    const config = await loadToolConfig(toolName, defaults, request.chatId);
    console.log(JSON.stringify(toolOk(await analyze(request, config))));
  } catch (error) {
    console.log(JSON.stringify(toolError(error?.message || String(error))));
  }
}

main();
