import crypto from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const toolName = "tools-archive";
if (!process.env.ARISA_PACKAGE_DIR) throw new Error("ARISA_PACKAGE_DIR is not set");
const importCore = (relativePath) => import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, "src", relativePath)).href);
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");
const { getChatToolTmpDir, getToolTmpDir, toolsDir } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`tools-archive

Usage:
  node index.js --help
  node index.js run --request-file <json>

Creates a zip archive of installed Arisa tool source. It excludes dependencies,
runtime data, local configuration, credentials, cookies, browser sessions, caches,
logs, and temporary output. Review source code before sharing the archive because
custom tools may contain deployment-specific values embedded directly in code.
`);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString("utf8"); });
    child.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function excludedPatterns() {
  return [
    "*/node_modules/*", "*/.git/*", "*/tmp/*", "*/out/*", "*/dist/*",
    "*/browser-profile/*", "*/web-cache/*", "*/.cache/*", "*/sessions/*",
    "*/auth/*", "*/credentials/*", "*/cookies/*", "*/config.js", "*/config.*.js",
    "*/.env", "*/.env.*", "*.log", "*.pid", "*.sqlite", "*.sqlite3", "*.db",
    "*cookies*.json", "*cookies*.txt", "*credentials*.json", "*token*.json"
  ];
}

async function createArchive(request) {
  await stat(toolsDir);
  const chatId = request.chatId == null ? null : String(request.chatId);
  const baseTmp = chatId ? getChatToolTmpDir(chatId, toolName) : getToolTmpDir(toolName);
  const workDir = path.join(baseTmp, crypto.randomBytes(6).toString("hex"));
  await mkdir(workDir, { recursive: true });
  const filePath = path.join(workDir, "arisa-tools.zip");
  const excludes = excludedPatterns().flatMap((pattern) => ["-x", pattern]);
  const result = await runProcess("zip", ["-q", "-r", filePath, ".", ...excludes], { cwd: toolsDir });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `zip exited with ${result.code}`);
  return toolOk({
    text: "Arisa tool source archive generated without local config or runtime data. Review custom source before sharing it.",
    filePath,
    fileName: "arisa-tools.zip",
    kind: "document",
    mimeType: "application/zip",
    delivery: { method: "document" }
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args[0] === "help") return printHelp();
  const requestFileIndex = args.indexOf("--request-file");
  if (args[0] !== "run" || requestFileIndex < 0 || !args[requestFileIndex + 1]) {
    console.log(JSON.stringify(toolError("Expected run --request-file <json>")));
    return;
  }
  try {
    const request = JSON.parse(await readFile(args[requestFileIndex + 1], "utf8"));
    console.log(JSON.stringify(await createArchive(request)));
  } catch (error) {
    console.log(JSON.stringify(toolError(error?.message || String(error))));
  }
}

await main();
