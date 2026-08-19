import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { compileOperations, parseOperations } from "./operations.js";
import { outputMetadata, runFfmpeg } from "./ffmpeg.js";

const toolName = "image-transform";
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");
const { getChatToolTmpDir } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`image-transform

Usage:
  node index.js --help
  node index.js run --request-file <json>

Apply an ordered JSON array of deterministic image operations.
Supported operation types:
  crop       Focal square crop: zoom, focusX, focusY; or fixed width, height, x, y
  resize     width, height, fit=contain|cover|fill, background
  rotate     degrees
  flip       axis=horizontal|vertical
  adjust     brightness, contrast, saturation
  grayscale  no options
  blur       sigma
  sharpen    no options
  format     format=jpeg|png|webp, quality=1..100

Example args.operations:
  [{"type":"crop","zoom":2,"focusX":0.55,"focusY":0.08},{"type":"resize","width":1024,"height":1024,"fit":"cover"},{"type":"format","format":"jpeg","quality":92}]
`);
}

async function run(requestFile) {
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    if (!request.chatId) throw new Error("chatId is required");
    if (!request.artifact?.path) throw new Error("An image artifact is required");
    const operations = parseOperations(request.args?.operations);
    const plan = compileOperations(operations);
    const metadata = outputMetadata(plan.format);
    const tmpDir = getChatToolTmpDir(request.chatId, toolName);
    await mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `image-transform-${crypto.randomUUID()}.${metadata.extension}`);
    await runFfmpeg({ sourcePath: request.artifact.path, outputPath, ...plan });
    console.log(JSON.stringify(toolOk({
      text: `Applied ${operations.length} image operation(s).`,
      filePath: outputPath,
      fileName: `image-transform.${metadata.extension}`,
      mimeType: metadata.mimeType,
      kind: "image",
      delivery: { method: "photo" },
      json: { operations, format: plan.format }
    })));
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
  }
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
else if (args[0] === "run" && args.includes("--request-file")) await run(args[args.indexOf("--request-file") + 1]);
else printHelp();
