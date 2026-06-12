import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readFile, stat, unlink } from "node:fs/promises";
import defaults from "./config.js";
import { loadToolConfig } from "../../src/core/tools/tool-config.js";
import { createDaemonRuntime } from "../../src/core/tools/daemon-runtime.js";
import { toolError, toolOk } from "../../src/core/tools/tool-result.js";
import { getToolConfigPath } from "../../src/runtime/paths.js";

const toolName = "whispermix-transcribe";
const config = await loadToolConfig(toolName, defaults);
const daemon = createDaemonRuntime({ toolName, entryPath: new URL(import.meta.url).pathname });

function printHelp() {
  console.log(`whispermix-transcribe\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nExpected input:\n  {\n    "artifact": { "path": "/abs/audio.ogg", "mimeType": "audio/ogg" },\n    "args": { "model": "efederici/parakeet-tdt-0.6b-v3-int4", "language": "spanish" }\n  }\n\nConfig at ${getToolConfigPath(toolName)}:\n  MODEL\n  FALLBACK_MODEL\n  LANGUAGE\n  IDLE_TIMEOUT_MS\n  READY_TIMEOUT_MS\n  JOB_TIMEOUT_MS\n`);
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
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
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
  await daemon.writeStatus({ state: "ready", message: "WhisperMix daemon ready" });
  const cache = new Map();
  await daemon.workLoop({
    idleTimeoutMs: asNumber(config.IDLE_TIMEOUT_MS, 600000),
    processJob: async (job) => transcribe(cache, job)
  });
}

const args = process.argv.slice(2);
if (args[0] === "daemon") await runDaemon();
else if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
else if (args[0] === "run") await run(args[args.indexOf("--request-file") + 1]);
else printHelp();
