import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const importCore = (relativePath) => import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, "src", relativePath)).href);
const { toolOk } = await importCore("core/tools/tool-result.js");

function printHelp() {
  console.log(`web-hello

Expose a minimal public web page at /hello when installed in Arisa.

Usage:
  node index.js --help
  node index.js run --request-file request.json
`);
}

async function run(requestFile) {
  if (!requestFile) {
    printHelp();
    return;
  }
  await readFile(requestFile, "utf8");
  console.log(JSON.stringify(toolOk({ text: "Open /hello on Arisa's HTTP server." })));
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
