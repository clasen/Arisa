import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import defaults from "./config.js";

const toolName = "youtube-transcript";

if (!process.env.ARISA_PACKAGE_DIR) throw new Error("ARISA_PACKAGE_DIR is not set");
const importCore = (relativePath) => import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, "src", relativePath)).href);
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");
const { getChatToolTmpDir, getToolTmpDir } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`youtube-transcript\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nInput:\n  text or args.url: YouTube URL\n\nArgs:\n  lang: preferred subtitle language, default es\n  format: text|markdown, default text\n  keepTimestamps: true|false, default false\n  cookiesPath: optional per-run Netscape cookies path\n\nConfig:\n  YTDLP_COMMAND: default yt-dlp\n  YOUTUBE_COOKIES_PATH: optional chat-scoped cookies.txt path\n`);
}

function truthy(value) {
  return value === true || String(value).toLowerCase() === "true";
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
  const parsed = new URL(String(url || "").trim());
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "youtu.be"].includes(hostname)) {
    throw new Error("Only YouTube URLs are supported");
  }
  if (hostname === "youtu.be") {
    const videoId = parsed.pathname.split("/").filter(Boolean)[0];
    if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  }
  const videoId = parsed.searchParams.get("v");
  if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  return parsed.toString();
}

function stripSrt(input) {
  return String(input || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n\r?\n+/)
    .map((block) => block.split(/\r?\n/).filter((line) => {
      const value = line.trim();
      if (!value) return false;
      if (/^\d+$/.test(value)) return false;
      if (/^\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(value)) return false;
      return true;
    }).join(" ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function srtWithTimestamps(input) {
  return String(input || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n\r?\n+/)
    .map((block) => {
      const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const time = lines.find((line) => /-->/.test(line));
      const text = lines.filter((line) => !/^\d+$/.test(line) && !/-->/.test(line)).join(" ").replace(/<[^>]+>/g, "").trim();
      if (!time || !text) return "";
      return `${time} ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

async function newestSubtitleFile(dir, lang) {
  const files = await readdir(dir);
  const exact = files.filter((name) => name.endsWith(`.${lang}.srt`));
  const srt = exact.length ? exact : files.filter((name) => name.endsWith(".srt"));
  if (!srt.length) throw new Error("yt-dlp did not produce an .srt subtitle file");
  const withStats = await Promise.all(srt.map(async (name) => ({ name, mtimeMs: (await stat(path.join(dir, name))).mtimeMs })));
  return path.join(dir, withStats.sort((a, b) => b.mtimeMs - a.mtimeMs)[0].name);
}

async function downloadTranscript(request, config) {
  const rawUrl = extractUrl(firstText(request));
  if (!rawUrl) throw new Error("No YouTube URL found in request text or args.url");
  const url = cleanUrl(rawUrl);
  const chatId = request.chatId == null ? null : String(request.chatId);
  const baseTmp = chatId ? getChatToolTmpDir(chatId, toolName) : getToolTmpDir(toolName);
  const workDir = path.join(baseTmp, crypto.randomBytes(6).toString("hex"));
  await mkdir(workDir, { recursive: true });

  const lang = String(request.args?.lang || "es");
  const cookiesPath = String(request.args?.cookiesPath || config.YOUTUBE_COOKIES_PATH || "").trim();
  const outputTemplate = path.join(workDir, "transcript.%(ext)s");
  const args = [
    "--skip-download",
    "--write-auto-subs",
    "--write-subs",
    "--sub-langs", `${lang},${lang}.*,en,en.*`,
    "--convert-subs", "srt",
    "--no-playlist",
    "-o", outputTemplate,
    url
  ];
  if (cookiesPath) args.unshift("--cookies", cookiesPath);

  const result = await runProcess(config.YTDLP_COMMAND || "yt-dlp", args, { timeout: 240000 });
  if (result.code !== 0) throw new Error(`yt-dlp transcript failed (exit ${result.code}). ${result.stderr || result.stdout}`.trim());

  const subtitleFile = await newestSubtitleFile(workDir, lang);
  const raw = await readFile(subtitleFile, "utf8");
  const keepTimestamps = truthy(request.args?.keepTimestamps);
  const transcript = keepTimestamps ? srtWithTimestamps(raw) : stripSrt(raw);
  if (!transcript) throw new Error("Subtitle file was empty after cleanup");

  const markdown = String(request.args?.format || "text").toLowerCase() === "markdown";
  const text = markdown ? `# YouTube transcript\n\nSource: ${url}\n\n${transcript}\n` : transcript;
  const fileName = markdown ? "youtube-transcript.md" : "youtube-transcript.txt";
  const filePath = path.join(workDir, fileName);
  await writeFile(filePath, `\uFEFF${text}`, "utf8");

  return {
    filePath,
    fileName,
    kind: "document",
    mimeType: markdown ? "text/markdown" : "text/plain",
    text: `Transcript downloaded for ${url}`
  };
}

async function main() {
  const [, , command, flag, requestFile] = process.argv;
  if (process.argv.includes("--help") || !command) return printHelp();
  if (command !== "run" || flag !== "--request-file" || !requestFile) {
    console.log(JSON.stringify(toolError("Invalid usage. Run node index.js --help.")));
    return;
  }
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    const config = await loadToolConfig(toolName, defaults, request.chatId);
    const output = await downloadTranscript(request, config);
    console.log(JSON.stringify(toolOk(output)));
  } catch (error) {
    console.log(JSON.stringify(toolError(error?.message || String(error))));
  }
}

main();
