import path from "node:path";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import defaults from "./config.js";
import { loadToolConfig } from "/Users/martinclasen/Stuff/Node/NPM/Arisa/src/core/tools/tool-config.js";
import { toolError, toolOk } from "/Users/martinclasen/Stuff/Node/NPM/Arisa/src/core/tools/tool-result.js";
import { getToolConfigPath } from "/Users/martinclasen/Stuff/Node/NPM/Arisa/src/runtime/paths.js";

const toolName = "summarize";
const config = await loadToolConfig(toolName, defaults);
const cliPath = path.join(process.cwd(), "node_modules", ".bin", "summarize");

function printHelp() {
  console.log(`summarize\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nExpected input:\n  {\n    "text": "https://youtu.be/VIDEO_ID",\n    "artifact": { "text": "https://youtu.be/VIDEO_ID" },\n    "args": {\n      "url": "https://youtu.be/VIDEO_ID",\n      "mode": "extract" | "summarize",\n      "youtube": "auto" | "web" | "no-auto" | "yt-dlp" | "apify",\n      "lang": "es",\n      "timestamps": "false",\n      "format": "text" | "md",\n      "markdownMode": "readability" | "llm" | "off",\n      "length": "xl",\n      "raw": "false"\n    }\n  }\n\nBehavior:\n  - Wraps steipete/summarize.\n  - Works with URLs, YouTube links, podcasts, and files.\n  - Defaults to extract mode for safe transcript/content extraction without requiring an LLM model.\n\nConfig at ${getToolConfigPath(toolName)}:\n  MODEL\n  OPENROUTER_API_KEY\n  OPENAI_API_KEY\n  ANTHROPIC_API_KEY\n  GOOGLE_API_KEY\n  GROQ_API_KEY\n`);
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return fallback;
}

function compactText(value = "") {
  return String(value).trim();
}

function buildEnv() {
  return {
    ...process.env,
    ...(config.MODEL ? { SUMMARIZE_MODEL: config.MODEL } : {}),
    ...(config.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: config.OPENROUTER_API_KEY } : {}),
    ...(config.OPENAI_API_KEY ? { OPENAI_API_KEY: config.OPENAI_API_KEY } : {}),
    ...(config.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY } : {}),
    ...(config.GOOGLE_API_KEY ? { GOOGLE_API_KEY: config.GOOGLE_API_KEY, GEMINI_API_KEY: config.GOOGLE_API_KEY } : {}),
    ...(config.GROQ_API_KEY ? { GROQ_API_KEY: config.GROQ_API_KEY } : {})
  };
}

function runProcess(args) {
  return new Promise((resolve) => {
    const child = spawn(cliPath, args, { cwd: process.cwd(), env: buildEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const args = request.args || {};
  const input = compactText(args.url || request.text || request.artifact?.text || "");

  if (!input) {
    console.log(JSON.stringify(toolError("A URL, file path, or text input is required in text, artifact.text, or args.url")));
    return;
  }

  const mode = compactText(args.mode || "extract") || "extract";
  const cliArgs = [input, "--plain", "--no-color", "--metrics", "off"];

  if (mode === "extract") {
    cliArgs.push("--extract");
  }

  if (args.youtube) cliArgs.push("--youtube", String(args.youtube));
  if (args.lang) cliArgs.push("--lang", String(args.lang));
  if (asBoolean(args.timestamps, false)) cliArgs.push("--timestamps");
  if (args.format) cliArgs.push("--format", String(args.format));
  if (args.markdownMode) cliArgs.push("--markdown-mode", String(args.markdownMode));
  if (args.length) cliArgs.push("--length", String(args.length));

  try {
    const result = await runProcess(cliArgs);
    if (result.code !== 0) {
      console.log(JSON.stringify(toolError(result.stderr || result.stdout || `summarize failed with code ${result.code}`)));
      return;
    }

    const text = asBoolean(args.raw, false)
      ? JSON.stringify({ stdout: result.stdout, stderr: result.stderr, cliArgs }, null, 2)
      : result.stdout.trim();

    console.log(JSON.stringify(toolOk({
      text,
      metadata: {
        mode,
        input,
        cliArgs
      }
    })));
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
  }
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
