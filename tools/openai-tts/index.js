import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import defaults from "./config.js";
import { loadToolConfig } from "../../src/core/tools/tool-config.js";
import { toolError, toolNeedsConfig, toolOk } from "../../src/core/tools/tool-result.js";
import { getToolConfigPath, getToolOutDir } from "../../src/runtime/paths.js";

const toolName = "openai-tts";
const config = await loadToolConfig(toolName, defaults);

function printHelp() {
  console.log(`openai-tts\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nExpected input:\n  {\n    \"text\": \"hello\",\n    \"artifact\": { \"text\": \"hello\" },\n    \"args\": { \"voice\": \"alloy\" }\n  }\n\nOutput:\n  - generates OGG/Opus audio\n  - suggests Telegram voice-note delivery via output.delivery.method = \"voice\"\n\nConfig at ${getToolConfigPath(toolName)}:\n  OPENAI_API_KEY\n  MODEL\n  VOICE\n`);
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
  const inputText = request.text || request.artifact?.text;
  if (!inputText) {
    console.log(JSON.stringify(toolError("text or artifact.text is required")));
    return;
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.MODEL,
      voice: request.args?.voice || config.VOICE,
      input: inputText,
      format: "opus"
    })
  });

  if (!response.ok) {
    const payload = await response.text();
    console.log(JSON.stringify(toolError(payload)));
    return;
  }

  const outDir = getToolOutDir(toolName);
  await mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, `speech-${Date.now()}.ogg`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, buffer);
  console.log(JSON.stringify(toolOk({
    filePath,
    fileName: path.basename(filePath),
    mimeType: "audio/ogg",
    kind: "audio",
    delivery: { method: "voice" }
  })));
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
