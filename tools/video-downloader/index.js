import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import defaults from "./config.js";
const toolName = "video-downloader";

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
  console.log(`video-downloader\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nExpected input:\n  {\n    "text": "https://www.youtube.com/watch?v=...",\n    "artifact": { "text": "https://x.com/..." },\n    "args": { "url": "...", "quality": "best|small" }\n  }\n\nOutput:\n  A generated video/mp4 artifact. Use a separate audio-extractor/media-converter tool when you need audio.\n\nSupported URLs:\n  YouTube, TikTok, Instagram, Facebook, X/Twitter, and other yt-dlp supported URLs.\n\nConfig at ${getToolConfigPath(toolName)}:\n  YTDLP_COMMAND (optional, default yt-dlp)\n  FFPROBE_COMMAND (optional, default ffprobe)\n  TWITTER_COOKIES_PATH (optional Netscape cookies file for X/Twitter)\n`);
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

function firstText(request = {}) {
  return String(request.args?.url || request.url || request.text || request.artifact?.text || "").trim();
}

function extractUrl(value = "") {
  const match = String(value).match(/https?:\/\/\S+/i);
  if (!match) return "";
  return match[0].replace(/[)\].,;!?]+$/g, "");
}

function cleanUrl(url) {
  const normalized = String(url || "").trim();
  if (/\b(tiktok\.com|twitter\.com|x\.com)\b/i.test(normalized)) return normalized.split("?")[0];
  if (normalized.includes("youtube.com")) {
    const videoId = normalized.match(/[?&]v=([^&]+)/)?.[1];
    if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
  }
  if (normalized.includes("youtu.be")) {
    const videoId = normalized.split("/").pop()?.split("?")[0];
    if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
  }
  return normalized;
}

function identifyPlatform(url) {
  const value = String(url).toLowerCase();
  if (value.includes("instagram.com")) return "instagram";
  if (value.includes("tiktok.com")) return "tiktok";
  if (value.includes("facebook.com") || value.includes("fb.watch")) return "facebook";
  if (value.includes("twitter.com") || value.includes("x.com")) return "twitter";
  if (value.includes("youtube.com") || value.includes("youtu.be")) return "youtube";
  return "video";
}

function ytdlpFormatArgs(quality = "best") {
  if (quality === "small") return ["-f", "best[height<=720][ext=mp4]/best[height<=720]/best", "--merge-output-format", "mp4"];
  return ["-f", "bestvideo*+bestaudio/best[ext=mp4]/best", "--merge-output-format", "mp4"];
}

async function assertReadable(filePath) {
  await access(filePath);
  const info = await stat(filePath);
  if (info.size < 16 * 1024) throw new Error(`Downloaded file is too small (${info.size} bytes)`);
}

async function validateMedia(command, filePath, kind) {
  const probe = await runProcess(command, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", filePath]);
  if (probe.code !== 0) throw new Error(`ffprobe failed: ${probe.stderr || probe.stdout}`);
  const streams = probe.stdout.split(/\s+/).filter(Boolean);
  if (kind === "video" && !streams.includes("video")) throw new Error("ffprobe did not detect a video stream");
  if (kind === "mp3" && !streams.includes("audio")) throw new Error("ffprobe did not detect an audio stream");
}

function buildCookiesArgs(config, url) {
  const isTwitter = /\b(twitter\.com|x\.com)\b/i.test(url);
  if (!isTwitter || !config.TWITTER_COOKIES_PATH) return [];
  return ["--cookies", config.TWITTER_COOKIES_PATH];
}

async function download(request, config) {
  const rawUrl = extractUrl(firstText(request));
  if (!rawUrl) throw new Error("No URL found in request text or args.url");
  const url = cleanUrl(rawUrl);
  const platform = identifyPlatform(url);
  const kind = "video";
  const chatId = request.chatId == null ? null : String(request.chatId);
  const tmpDir = chatId ? getChatToolTmpDir(chatId, toolName) : getToolTmpDir(toolName);
  await mkdir(tmpDir, { recursive: true });

  const id = crypto.randomBytes(5).toString("hex");
  const outputTemplate = path.join(tmpDir, `${platform}_${Date.now()}_${id}.%(ext)s`);
  const quality = String(request.args?.quality || request.quality || "best").toLowerCase();
  const args = [
    "--no-playlist",
    "--no-progress",
    ...buildCookiesArgs(config, url),
    ...ytdlpFormatArgs(quality),
    "--print", "after_move:filepath",
    "-o", outputTemplate,
    url
  ];
  if (platform === "twitter") {
    args.splice(2, 0, "--referer", "https://x.com/", "--add-header", "User-Agent: Mozilla/5.0");
  }

  const result = await runProcess(config.YTDLP_COMMAND || "yt-dlp", args, { timeout: 300000 });
  if (result.code !== 0) throw new Error(`yt-dlp failed (exit ${result.code}). ${result.stderr || result.stdout}`.trim());
  const filePath = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).pop();
  if (!filePath) throw new Error("yt-dlp did not return an output file path");
  await assertReadable(filePath);
  await validateMedia(config.FFPROBE_COMMAND || "ffprobe", filePath, kind);

  return {
    filePath,
    fileName: path.basename(filePath),
    kind: "video",
    mimeType: "video/mp4",
    text: `Downloaded video from ${platform}: ${path.basename(filePath)}`
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
    const output = await download(request, config);
    console.log(JSON.stringify(toolOk(output)));
  } catch (error) {
    console.log(JSON.stringify(toolError(error?.message || String(error))));
  }
}

main();
