import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { compileOperations, parseOperations, supportedSharpMethods } from "./operations.js";
import { outputMetadata, runSharp } from "./sharp-runner.js";

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

Build an ordered Sharp pipeline from JSON. Use Sharp method names directly:
  [{"method":"resize","args":[{"width":1024,"height":1024,"fit":"cover"}]},{"method":"modulate","args":[{"saturation":1.15}]},{"method":"webp","args":[{"quality":90}]}]

A method may use "options" instead of a one-element "args" array. Up to 32 operations are accepted.
Local file references inside operation arguments are rejected; the source and output remain artifact-scoped.

Supported chain/output methods:
  ${supportedSharpMethods.join(", ")}

Legacy operations remain compatible:
  crop, resize, rotate, flip, adjust, grayscale, blur, sharpen, format
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
    const info = await runSharp({ sourcePath: request.artifact.path, outputPath, pipeline: plan.pipeline });
    console.log(JSON.stringify(toolOk({
      text: `Applied ${operations.length} image operation(s) with Sharp.`,
      filePath: outputPath,
      fileName: `image-transform.${metadata.extension}`,
      mimeType: metadata.mimeType,
      kind: "image",
      delivery: { method: ["jpeg", "png", "webp"].includes(plan.format) ? "photo" : "document" },
      json: { operations, format: plan.format, width: info.width, height: info.height, size: info.size }
    })));
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
  }
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
else if (args[0] === "run" && args.includes("--request-file")) await run(args[args.indexOf("--request-file") + 1]);
else printHelp();
