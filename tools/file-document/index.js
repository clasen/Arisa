import path from "node:path";
import os from "node:os";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolDir = path.dirname(fileURLToPath(import.meta.url));

async function getArisaPackageDir() {
  if (process.env.ARISA_PACKAGE_DIR) return process.env.ARISA_PACKAGE_DIR;
  try {
    return (await readFile(path.join(os.homedir(), ".arisa", "arisa-package-dir"), "utf8")).trim();
  } catch {
    return path.resolve(toolDir, "../../package");
  }
}

const importCore = async (relativePath) => import(pathToFileURL(path.join(await getArisaPackageDir(), "src", relativePath)).href);
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");

function printHelp() {
  console.log(`file-document\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nInput text should be an absolute local file path. Returns it as a document artifact.`);
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md") return "text/markdown";
  if (ext === ".txt") return "text/plain";
  return "application/octet-stream";
}

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const filePath = String(request.text || request.artifact?.text || "").trim();
  if (!path.isAbsolute(filePath)) return console.log(JSON.stringify(toolError("absolute file path is required")));
  try {
    await stat(filePath);
    console.log(JSON.stringify(toolOk({
      text: `Document ready: ${path.basename(filePath)}`,
      filePath,
      fileName: path.basename(filePath),
      kind: "document",
      mimeType: mimeFor(filePath)
    })));
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
  }
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
else if (args[0] === "run") await run(args[args.indexOf("--request-file") + 1]);
else printHelp();
