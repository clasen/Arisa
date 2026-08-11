import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");
const { getChatToolStateDir, getToolStateDir } = await importCore("runtime/paths.js");

const toolName = "web-browser";
const fallbackDelayMs = 500;

function printHelp() {
  console.log(`web-browser\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nExpected input:\n  {\n    "text": "weather toronto" | "https://example.com",\n    "artifact": { "text": "weather toronto" },\n    "args": {\n      "mode": "search" | "open",\n      "url": "https://example.com",\n      "maxResults": "5"\n    }\n  }\n\nBehavior:\n  - If the input looks like a URL, open the page.\n  - Otherwise, perform a web search.\n  - When possible, opening pages uses r.jina.ai with a direct fetch fallback.\n`);
}

function decodeHtml(text = "") {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(html = "") {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  ).trim();
}

function normalizeUrl(value = "") {
  const text = value.trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(text)) return `https://${text}`;
  return "";
}

function extractActualUrl(duckUrl) {
  try {
    const parsed = new URL(duckUrl.startsWith("//") ? `https:${duckUrl}` : duckUrl);
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : parsed.toString();
  } catch {
    return duckUrl;
  }
}

function extractBingUrl(value) {
  try {
    const parsed = new URL(decodeHtml(value));
    const encoded = parsed.searchParams.get("u");
    if (!encoded?.startsWith("a1")) return parsed.toString();
    const base64 = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(base64, "base64").toString("utf8");
  } catch {
    return decodeHtml(value);
  }
}

function formatSearchResults(query, results) {
  if (!results.length) return `Search: ${query}\n\nNo parseable results were found.`;
  return [
    `Search: ${query}`,
    "",
    ...results.flatMap((item, index) => [
      `${index + 1}. ${item.title}`,
      `URL: ${item.url}`,
      `Snippet: ${item.snippet}`,
      item.displayUrl ? `Displayed: ${item.displayUrl}` : null,
      ""
    ].filter(Boolean))
  ].join("\n").trim();
}

function parseDuckDuckGoResults(html, maxResults) {
  const results = [];
  const blocks = html.split(/<div class="result results_links[\s\S]*?web-result ">/i).slice(1);
  for (const block of blocks) {
    if (results.length >= maxResults) break;
    const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const displayUrlMatch = block.match(/<a[^>]*class="result__url"[^>]*>([\s\S]*?)<\/a>/i);
    results.push({
      title: stripHtml(titleMatch[2]),
      url: extractActualUrl(titleMatch[1]),
      snippet: stripHtml(snippetMatch?.[1] || ""),
      displayUrl: stripHtml(displayUrlMatch?.[1] || "")
    });
  }
  return results;
}

function parseBingResults(html, maxResults) {
  const results = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) || [];
  for (const block of blocks) {
    if (results.length >= maxResults) break;
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const snippetMatch = block.match(/<div[^>]*class="b_caption"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
    const displayUrlMatch = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
    results.push({
      title: stripHtml(titleMatch[2]),
      url: extractBingUrl(titleMatch[1]),
      snippet: stripHtml(snippetMatch?.[1] || ""),
      displayUrl: stripHtml(displayUrlMatch?.[1] || "")
    });
  }
  return results;
}

function stripMarkdown(text = "") {
  return decodeHtml(text)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJinaBingResults(markdown, maxResults) {
  const results = [];
  const pattern = /^## \[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*\n+([^\n#][^\n]*)?/gm;
  for (const match of markdown.matchAll(pattern)) {
    if (results.length >= maxResults) break;
    const url = extractBingUrl(match[2]);
    if (!/^https?:\/\//i.test(url) || /(^|\.)bing\.com$/i.test(new URL(url).hostname)) continue;
    results.push({
      title: stripMarkdown(match[1]),
      url,
      snippet: stripMarkdown(match[3] || ""),
      displayUrl: new URL(url).hostname
    });
  }
  return results;
}

function parseJinaDuckDuckGoResults(markdown, maxResults) {
  const results = [];
  const blocks = markdown.split(/^## /m).slice(1);
  for (const block of blocks) {
    if (results.length >= maxResults) break;
    const heading = block.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
    if (!heading) continue;
    const url = extractActualUrl(heading[2]);
    if (!/^https?:\/\//i.test(url) || /(^|\.)duckduckgo\.com$/i.test(new URL(url).hostname)) continue;
    const linkedTexts = [...block.matchAll(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g)]
      .map((match) => stripMarkdown(match[1]))
      .filter((text) => text && !/^Image \d+/i.test(text));
    results.push({
      title: stripMarkdown(heading[1]),
      url,
      snippet: linkedTexts.at(-1) || "",
      displayUrl: new URL(url).hostname
    });
  }
  return results;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept-language": "en-US,en;q=0.9"
    },
    redirect: "follow"
  });
  return { response, text: await response.text() };
}

async function searchProvider(url, parser, maxResults) {
  const { response, text: html } = await fetchText(url);
  if (!response.ok) throw new Error(`status ${response.status}`);
  return parser(html, maxResults);
}

function buildSearchProviders(query) {
  return [
    {
      name: "DuckDuckGo",
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      parser: parseDuckDuckGoResults
    },
    {
      name: "Bing",
      url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      parser: parseBingResults
    },
    {
      name: "Jina DuckDuckGo proxy",
      url: `https://r.jina.ai/http://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      parser: parseJinaDuckDuckGoResults
    },
    {
      name: "Jina Bing proxy",
      url: `https://r.jina.ai/http://www.bing.com/search?q=${encodeURIComponent(query)}`,
      parser: parseJinaBingResults
    }
  ];
}

function rotateProviders(providers, startIndex) {
  return providers.map((_, offset) => providers[(startIndex + offset) % providers.length]);
}

async function writeRotationState(file, state) {
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryFile, `\uFEFF${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryFile, file);
}

async function claimProviderStartIndex(chatId, providerCount) {
  const stateDir = chatId === undefined || chatId === null
    ? getToolStateDir(toolName)
    : getChatToolStateDir(chatId, toolName);
  const stateFile = path.join(stateDir, "provider-rotation.json");
  await mkdir(stateDir, { recursive: true });

  let startIndex = 0;
  try {
    const stored = JSON.parse((await readFile(stateFile, "utf8")).replace(/^\uFEFF/, ""));
    startIndex = Number.isInteger(stored.nextProviderIndex)
      ? stored.nextProviderIndex % providerCount
      : 0;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }

  await writeRotationState(stateFile, {
    nextProviderIndex: (startIndex + 1) % providerCount,
    updatedAt: new Date().toISOString()
  });
  return startIndex;
}

async function searchWeb(query, maxResults = 5, chatId) {
  const providers = buildSearchProviders(query);
  const startIndex = await claimProviderStartIndex(chatId, providers.length);
  const rotatedProviders = rotateProviders(providers, startIndex);
  const errors = [];

  for (const [index, provider] of rotatedProviders.entries()) {
    try {
      const results = await searchProvider(provider.url, provider.parser, maxResults);
      if (results.length) return formatSearchResults(query, results);
      errors.push(`${provider.name}: no parseable results`);
    } catch (error) {
      errors.push(`${provider.name}: ${error.message || String(error)}`);
    }
    if (index < rotatedProviders.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, fallbackDelayMs));
    }
  }
  throw new Error(`Search failed (${errors.join("; ")})`);
}

async function openWebPage(inputUrl) {
  const targetUrl = normalizeUrl(inputUrl);
  if (!targetUrl) throw new Error("A valid URL is required");

  const jinaUrl = `https://r.jina.ai/http://${targetUrl.replace(/^https?:\/\//i, "")}`;
  let body = "";
  let source = "jina-ai";

  try {
    const { response, text } = await fetchText(jinaUrl);
    if (!response.ok) throw new Error(`r.jina.ai status ${response.status}`);
    body = text.trim();
  } catch {
    const { response, text } = await fetchText(targetUrl);
    if (!response.ok) throw new Error(`Open failed with status ${response.status}`);
    body = stripHtml(text);
    source = "direct-fetch";
  }

  const shortened = body.length > 12000 ? `${body.slice(0, 12000)}\n\n[content truncated]` : body;
  return [`Page: ${targetUrl}`, `Source: ${source}`, "", shortened].join("\n").trim();
}

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const rawInput = request.args?.url || request.text || request.artifact?.text || "";
  const mode = request.args?.mode || (normalizeUrl(rawInput) ? "open" : "search");
  const maxResults = Number.parseInt(request.args?.maxResults || "5", 10);

  if (!rawInput.trim()) {
    console.log(JSON.stringify(toolError("text, artifact.text, or args.url is required")));
    return;
  }

  try {
    const outputText = mode === "open"
      ? await openWebPage(rawInput)
      : await searchWeb(rawInput, Number.isFinite(maxResults) ? maxResults : 5, request.chatId);
    console.log(JSON.stringify(toolOk({ text: outputText })));
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
