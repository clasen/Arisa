import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { cropImage } from "./crop.js";

const toolName = "image-crop";
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");
const { getChatToolTmpDir } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`image-crop

Usage:
  node index.js --help
  node index.js run --request-file <json>

Crop an image artifact to a square and resize it. Optional args:
  zoom     1–8; higher values crop closer (default 1)
  focusX   Horizontal focal position from 0 to 1 (default 0.5)
  focusY   Vertical focal position from 0 to 1 (default 0.5)
  size     Output width and height in pixels, 64–4096 (default 1024)
  quality  JPEG quality scale used by ffmpeg, 2–31; lower is better (default 2)

Example:
  { "chatId": "123", "artifact": { "path": "/tmp/input.jpg" }, "args": { "zoom": "2", "focusX": "0.55", "focusY": "0.08" } }
`);
}

async function run(requestFile) {
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    if (!request.chatId) throw new Error("chatId is required");
    if (!request.artifact?.path) throw new Error("An image artifact is required");
    const tmpDir = getChatToolTmpDir(request.chatId, toolName);
    await mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `image-crop-${crypto.randomUUID()}.jpg`);
    const result = await cropImage({ sourcePath: request.artifact.path, outputPath, args: request.args });
    console.log(JSON.stringify(toolOk({
      text: "Image cropped.",
      filePath: outputPath,
      fileName: "image-crop.jpg",
      mimeType: "image/jpeg",
      kind: "image",
      delivery: { method: "photo" },
      json: result.options
    })));
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
  }
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
else if (args[0] === "run" && args.includes("--request-file")) await run(args[args.indexOf("--request-file") + 1]);
else printHelp();
