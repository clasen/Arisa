import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const importCore = (relativePath) => import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, "src", relativePath)).href);
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");

function printHelp() {
  console.log(`url-to-markdown

Usage:
  node index.js --help
  node index.js run --request-file <json>

Fetches a URL through r.jina.ai and returns a Markdown document file.
`);
}

function extractUrl(value = "") {
  const match = String(value).match(/https?:\/\/\S+/i);
  return match ? match[0].replace(/[)\].,;!?]+$/g, "") : "";
}

function slugify(value = "") {
  return String(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "article";
}

async function fetchText(url) {
  const target = `https://r.jina.ai/http://${url.replace(/^https?:\/\//i, "")}`;
  const response = await fetch(target, { headers: { "user-agent": "Mozilla/5.0" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`Fetch failed with status ${response.status}: ${text.slice(0, 200)}`);
  return text;
}

async function run(requestFile) {
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    const input = request.args?.url || request.text || request.artifact?.text || "";
    const url = extractUrl(input);
    if (!url) throw new Error("A URL is required");
    const markdown = await fetchText(url);
    const title = markdown.match(/^Title:\s*(.+)$/m)?.[1] || new URL(url).hostname;
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "url-md-"));
    const fileName = `${slugify(title)}.md`;
    const filePath = path.join(tmpDir, fileName);
    await writeFile(filePath, markdown, "utf8");
    console.log(JSON.stringify(toolOk({
      text: `Markdown transcript generated for ${url}`,
      filePath,
      fileName,
      kind: "document",
      mimeType: "text/markdown",
      delivery: { method: "document" }
    })));
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
  }
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
else if (args[0] === "run") await run(args[args.indexOf("--request-file") + 1]);
else printHelp();
