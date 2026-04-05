import { readFile } from "node:fs/promises";

function printHelp() {
  console.log(`web-browser\n\nUso:\n  node index.js --help\n  node index.js run --request-file <json>\n\nInput esperado:\n  {\n    "text": "weather toronto" | "https://example.com",\n    "artifact": { "text": "weather toronto" },\n    "args": {\n      "mode": "search" | "open",\n      "url": "https://example.com",\n      "maxResults": "5"\n    }\n  }\n\nComportamiento:\n  - Si el input parece una URL, abre la página.\n  - Si no, hace una búsqueda web.\n  - Para abrir páginas usa r.jina.ai cuando es posible, con fallback a fetch directo.\n`);
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

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept-language": "es-AR,es;q=0.9,en;q=0.8"
    },
    redirect: "follow"
  });
  return { response, text: await response.text() };
}

async function searchWeb(query, maxResults = 5) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { response, text: html } = await fetchText(url);
  if (!response.ok) throw new Error(`Search failed with status ${response.status}`);

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

  if (!results.length) {
    return `Búsqueda: ${query}\n\nNo encontré resultados parseables.`;
  }

  return [
    `Búsqueda: ${query}`,
    "",
    ...results.flatMap((item, index) => [
      `${index + 1}. ${item.title}`,
      `URL: ${item.url}`,
      `Resumen: ${item.snippet}`,
      item.displayUrl ? `Mostrado: ${item.displayUrl}` : null,
      ""
    ].filter(Boolean))
  ].join("\n").trim();
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

  const shortened = body.length > 12000 ? `${body.slice(0, 12000)}\n\n[contenido truncado]` : body;
  return [`Página: ${targetUrl}`, `Fuente: ${source}`, "", shortened].join("\n").trim();
}

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const rawInput = request.args?.url || request.text || request.artifact?.text || "";
  const mode = request.args?.mode || (normalizeUrl(rawInput) ? "open" : "search");
  const maxResults = Number.parseInt(request.args?.maxResults || "5", 10);

  if (!rawInput.trim()) {
    console.log(JSON.stringify({ ok: false, error: "text, artifact.text, or args.url is required" }));
    return;
  }

  try {
    const outputText = mode === "open"
      ? await openWebPage(rawInput)
      : await searchWeb(rawInput, Number.isFinite(maxResults) ? maxResults : 5);
    console.log(JSON.stringify({ ok: true, output: { text: outputText } }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message || String(error) }));
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
