import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import defaults from "./config.js";
import { loadToolConfig } from "../../src/core/tools/tool-config.js";
import { getToolConfigPath } from "../../src/runtime/paths.js";

const toolName = "openai-transcribe";
const config = await loadToolConfig(toolName, defaults);

function printHelp() {
  console.log(`openai-transcribe\n\nUso:\n  node index.js --help\n  node index.js run --request-file <json>\n\nInput esperado:\n  {\n    \"artifact\": { \"path\": \"/abs/audio.ogg\", \"mimeType\": \"audio/ogg\" },\n    \"args\": {}\n  }\n\nConfig en ${getToolConfigPath(toolName)}:\n  OPENAI_API_KEY\n  MODEL\n`);
}

async function run(requestFile) {
  if (!config.OPENAI_API_KEY) {
    console.log(JSON.stringify({ ok: false, missingConfig: ["OPENAI_API_KEY"], configPath: getToolConfigPath(toolName) }));
    return;
  }

  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const artifact = request.artifact;
  if (!artifact?.path) {
    console.log(JSON.stringify({ ok: false, error: "artifact.path is required" }));
    return;
  }

  await stat(artifact.path);
  const form = new FormData();
  const data = await readFile(artifact.path);
  form.append("file", new Blob([data]), path.basename(artifact.path));
  form.append("model", config.MODEL);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
    body: form
  });

  const payload = await response.json();
  if (!response.ok) {
    console.log(JSON.stringify({ ok: false, error: payload.error?.message || "OpenAI transcription failed" }));
    return;
  }

  console.log(JSON.stringify({ ok: true, output: { text: payload.text || "" } }));
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
