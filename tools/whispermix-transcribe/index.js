import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { readFile, stat, unlink } from "node:fs/promises";
import defaults from "./config.js";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { createDaemonRuntime } = await importCore("core/tools/daemon-runtime.js");
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");
const { getToolConfigPath } = await importCore("runtime/paths.js");

const toolName = "whispermix-transcribe";
let config = await loadToolConfig(toolName, defaults);
const daemon = createDaemonRuntime({
  toolName,
  entryPath: fileURLToPath(import.meta.url),
  autoStart: false
});

function printHelp() {
  console.log(`whispermix-transcribe\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nExpected input:\n  {\n    "artifact": { "path": "/abs/audio.ogg", "mimeType": "audio/ogg" },\n    "args": { "model": "efederici/parakeet-tdt-0.6b-v3-int4", "language": "auto" }\n  }\n\nConfig at ${getToolConfigPath(toolName)}:\n  MODEL\n  FALLBACK_MODEL\n  LANGUAGE\n  IDLE_TIMEOUT_MS\n  READY_TIMEOUT_MS\n  JOB_TIMEOUT_MS\n`);
}

function asNumber(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(result) {
  if (typeof result === "string") return result;
  if (result && typeof result.text === "string") return result.text;
  return String(result || "");
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function convertToWav(inputPath) {
  const outputPath = path.join(os.tmpdir(), `whispermix-${crypto.randomUUID()}.wav`);
  const result = await runProcess("ffmpeg", ["-y", "-i", inputPath, "-vn", "-ar", "16000", "-ac", "1", "-f", "wav", outputPath]);
  if (result.code !== 0) throw new Error(`ffmpeg conversion failed: ${result.stderr || result.stdout}`.trim());
  return outputPath;
}

async function getModel(cache, model, language) {
  const key = `${model}::${language}`;
  if (!cache.has(key)) {
    const { default: WhisperMix } = await import("whispermix");
    cache.set(key, new WhisperMix({ model, language }));
  }
  return cache.get(key);
}

async function transcribeWith(cache, wavPath, model, language) {
  const whisper = await getModel(cache, model, language);
  const text = normalizeText(await whisper.fromFile(wavPath)).trim();
  if (!text) throw new Error(`${model} returned no text output`);
  return text;
}

async function transcribe(cache, job) {
  let wavPath = "";
  try {
    wavPath = await convertToWav(job.filePath);
    const model = job.model || config.MODEL;
    const language = job.language || config.LANGUAGE;
    try {
      return { text: await transcribeWith(cache, wavPath, model, language) };
    } catch (error) {
      if (!config.FALLBACK_MODEL || config.FALLBACK_MODEL === model) throw error;
      return { text: await transcribeWith(cache, wavPath, config.FALLBACK_MODEL, language) };
    }
  } finally {
    if (wavPath) await unlink(wavPath).catch(() => {});
  }
}

async function healthCheck(cache) {
  const wavPath = path.join(os.tmpdir(), `whispermix-health-${crypto.randomUUID()}.wav`);
  try {
    const generated = await runProcess("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=1000:sample_rate=16000",
      "-t", "1",
      "-f", "wav",
      wavPath
    ]);
    if (generated.code !== 0) {
      throw new Error(`ffmpeg health audio generation failed: ${generated.stderr || generated.stdout}`.trim());
    }
    const model = await getModel(cache, config.MODEL, config.LANGUAGE);
    await model.fromFile(wavPath);
    return { message: "WhisperMix model inference and ffmpeg are healthy" };
  } finally {
    await unlink(wavPath).catch(() => {});
  }
}

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const artifact = request.artifact;
  if (!artifact?.path) return console.log(JSON.stringify(toolError("artifact.path is required")));

  try {
    await stat(artifact.path);
    const output = await daemon.submit({
      filePath: artifact.path,
      model: request.args?.model || config.MODEL,
      language: request.args?.language || config.LANGUAGE
    }, {
      timeoutMs: asNumber(config.JOB_TIMEOUT_MS, 180000),
      readyTimeoutMs: asNumber(config.READY_TIMEOUT_MS, 120000)
    });
    console.log(JSON.stringify(toolOk({ text: String(output.text || "").trim() })));
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
  }
}

async function runDaemon() {
  config = await loadToolConfig(toolName, defaults);
  const cache = new Map();
  await daemon.workLoop({
    idleTimeoutMs: asNumber(config.IDLE_TIMEOUT_MS, 600000),
    processJob: async (job) => transcribe(cache, job),
    healthCheck: () => healthCheck(cache),
    recover: async () => {
      cache.clear();
      config = await loadToolConfig(toolName, defaults);
      return true;
    }
  });
}

const args = process.argv.slice(2);
if (args[0] === "daemon") await runDaemon();
else if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
else if (args[0] === "run") await run(args[args.indexOf("--request-file") + 1]);
else printHelp();
