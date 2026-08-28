import { parsePublicHttpUrl } from "./url-security.js";

const directProviders = Object.freeze([
  { name: "Bing", url: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`, parser: parseBingResults },
  { name: "DuckDuckGo", url: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, parser: parseDuckDuckGoResults }
]);
const proxyProviders = Object.freeze([
  { name: "Jina Bing proxy", url: (query) => `https://r.jina.ai/http://www.bing.com/search?q=${encodeURIComponent(query)}`, parser: parseJinaBingResults },
  { name: "Jina DuckDuckGo proxy", url: (query) => `https://r.jina.ai/http://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, parser: parseJinaDuckDuckGoResults }
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function decodeHtml(text = "") {
  return text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function stripHtml(html = "") {
  return decodeHtml(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

function stripMarkdown(text = "") {
  return decodeHtml(text).replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
}

function safeResultUrl(value) {
  try { return parsePublicHttpUrl(value).href; }
  catch { return ""; }
}

function extractActualUrl(value) {
  try {
    const parsed = new URL(value.startsWith("//") ? `https:${value}` : value);
    const target = parsed.searchParams.get("uddg");
    return safeResultUrl(target ? decodeURIComponent(target) : parsed.href);
  } catch {
    return "";
  }
}

function extractBingUrl(value) {
  try {
    const parsed = new URL(decodeHtml(value));
    const encoded = parsed.searchParams.get("u");
    if (!encoded?.startsWith("a1")) return safeResultUrl(parsed.href);
    const base64 = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    return safeResultUrl(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    return "";
  }
}

export function parseDuckDuckGoResults(html, maxResults) {
  const results = [];
  for (const block of String(html).split(/<div class="result results_links[\s\S]*?web-result ">/i).slice(1)) {
    if (results.length >= maxResults) break;
    const title = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!title) continue;
    const url = extractActualUrl(title[1]);
    if (!url) continue;
    const snippet = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const display = block.match(/<a[^>]*class="result__url"[^>]*>([\s\S]*?)<\/a>/i);
    results.push({ title: stripHtml(title[2]), url, snippet: stripHtml(snippet?.[1] || ""), displayUrl: stripHtml(display?.[1] || "") });
  }
  return results;
}

export function parseBingResults(html, maxResults) {
  const results = [];
  for (const block of String(html).match(/<li class="b_algo"[\s\S]*?<\/li>/gi) || []) {
    if (results.length >= maxResults) break;
    const title = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!title) continue;
    const url = extractBingUrl(title[1]);
    if (!url) continue;
    const snippet = block.match(/<div[^>]*class="b_caption"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
    const display = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
    results.push({ title: stripHtml(title[2]), url, snippet: stripHtml(snippet?.[1] || ""), displayUrl: stripHtml(display?.[1] || "") });
  }
  return results;
}

export function parseJinaBingResults(markdown, maxResults) {
  const results = [];
  const pattern = /^## \[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*\n+([^\n#][^\n]*)?/gm;
  for (const match of String(markdown).matchAll(pattern)) {
    if (results.length >= maxResults) break;
    const url = extractBingUrl(match[2]);
    if (!url || /(^|\.)bing\.com$/i.test(new URL(url).hostname)) continue;
    results.push({ title: stripMarkdown(match[1]), url, snippet: stripMarkdown(match[3] || ""), displayUrl: new URL(url).hostname });
  }
  return results;
}

export function parseJinaDuckDuckGoResults(markdown, maxResults) {
  const results = [];
  for (const block of String(markdown).split(/^## /m).slice(1)) {
    if (results.length >= maxResults) break;
    const heading = block.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
    if (!heading) continue;
    const url = extractActualUrl(heading[2]);
    if (!url || /(^|\.)duckduckgo\.com$/i.test(new URL(url).hostname)) continue;
    const linkedTexts = [...block.matchAll(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g)].map((match) => stripMarkdown(match[1])).filter((text) => text && !/^Image \d+/i.test(text));
    results.push({ title: stripMarkdown(heading[1]), url, snippet: linkedTexts.at(-1) || "", displayUrl: new URL(url).hostname });
  }
  return results;
}

export async function readBoundedText(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Search provider response exceeds ${maxBytes} bytes.`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function queryProvider(provider, query, { maxResults, maxResponseBytes, signal, fetchImpl }) {
  const response = await fetchImpl(provider.url(query), {
    headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" },
    redirect: "follow",
    signal
  });
  if (!response.ok) throw new Error(`${provider.name} returned HTTP ${response.status}.`);
  const results = provider.parser(await readBoundedText(response, maxResponseBytes), maxResults);
  if (!results.length) throw new Error(`${provider.name} returned no parseable semantic results.`);
  return { provider: provider.name, results };
}

async function fastestProvider(providers, query, options) {
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = AbortSignal.any([controller.signal, timeout]);
  try {
    return await Promise.any(providers.map((provider) => queryProvider(provider, query, { ...options, signal })));
  } finally {
    controller.abort();
  }
}

export function formatSearchResults(query, results) {
  return [`Search: ${query}`, "", ...results.flatMap((item, index) => [
    `${index + 1}. ${item.title}`, `URL: ${item.url}`, `Snippet: ${item.snippet}`, item.displayUrl ? `Displayed: ${item.displayUrl}` : null, ""
  ].filter((value) => value !== null))].join("\n").trim();
}

export async function searchWeb(query, options = {}) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery || Buffer.byteLength(normalizedQuery) > 500) throw new Error("Search query must contain 1 to 500 UTF-8 bytes.");
  const maxResults = boundedInteger(options.maxResults, 5, 1, 10);
  const timeoutMs = boundedInteger(options.timeoutMs, 10_000, 1_000, 15_000);
  const maxResponseBytes = boundedInteger(options.maxResponseBytes, 512 * 1024, 64 * 1024, 1024 * 1024);
  const fetchImpl = options.fetchImpl || fetch;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const errors = [];
  let output;
  for (const providers of [directProviders, proxyProviders]) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 1) break;
    try {
      output = await fastestProvider(providers, normalizedQuery, { maxResults, timeoutMs: remainingMs, maxResponseBytes, fetchImpl });
      break;
    } catch (error) {
      errors.push(...(error instanceof AggregateError ? error.errors : [error]).map((item) => String(item?.message || item)));
    }
  }
  if (!output) throw Object.assign(new Error(`Search failed (${errors.join("; ").slice(0, 1000)})`), { code: "LIGHTPANDA_SEARCH_FAILED", retryable: true });
  return { ...output, query: normalizedQuery, elapsedMs: Date.now() - startedAt, text: formatSearchResults(normalizedQuery, output.results) };
}
