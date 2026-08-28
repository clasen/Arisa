import test from "node:test";
import assert from "node:assert/strict";
import { parseBingResults, parseDuckDuckGoResults, readBoundedText, searchWeb } from "../web-search.js";

const bingHtml = `<ol><li class="b_algo"><h2><a href="https://example.com/article">Example result</a></h2><div class="b_caption"><p>A semantic search snippet.</p></div><cite>example.com</cite></li></ol>`;
const duckHtml = `<div class="result results_links web-result "><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fstory">Duck result</a><a class="result__snippet">Another semantic snippet.</a><a class="result__url">example.org/story</a></div>`;

test("parses semantic Bing and DuckDuckGo results", () => {
  assert.deepEqual(parseBingResults(bingHtml, 5), [{
    title: "Example result", url: "https://example.com/article", snippet: "A semantic search snippet.", displayUrl: "example.com"
  }]);
  assert.deepEqual(parseDuckDuckGoResults(duckHtml, 5), [{
    title: "Duck result", url: "https://example.org/story", snippet: "Another semantic snippet.", displayUrl: "example.org/story"
  }]);
});

test("hedges direct providers and returns the first parseable semantic result", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("bing.com")) return new Response(bingHtml, { status: 200 });
    return new Response("<html>no results</html>", { status: 200 });
  };
  const output = await searchWeb("lightweight browser", { fetchImpl, maxResults: 3, timeoutMs: 2_000 });
  assert.equal(output.provider, "Bing");
  assert.equal(output.results.length, 1);
  assert.match(output.text, /^Search: lightweight browser/m);
  assert.match(output.text, /URL: https:\/\/example\.com\/article/);
  assert.equal(calls.some((url) => url.includes("bing.com")), true);
  assert.equal(calls.some((url) => url.includes("duckduckgo.com")), true);
});

test("uses fixed Jina proxies only when both direct providers are unparseable", async () => {
  const fetchImpl = async (url) => {
    if (!url.startsWith("https://r.jina.ai/")) return new Response("<html>no results</html>", { status: 200 });
    if (url.includes("bing.com")) return new Response("## [Proxy result](https://example.net/proxy)\nA bounded fallback snippet.", { status: 200 });
    return new Response("", { status: 200 });
  };
  const output = await searchWeb("proxy fallback", { fetchImpl, timeoutMs: 2_000 });
  assert.equal(output.provider, "Jina Bing proxy");
  assert.equal(output.results[0].url, "https://example.net/proxy");
});

test("bounds query, result count, provider bytes, and unsafe result URLs", async () => {
  await assert.rejects(searchWeb("x".repeat(501), { fetchImpl: fetch }), /1 to 500 UTF-8 bytes/);
  await assert.rejects(readBoundedText(new Response("x".repeat(70 * 1024)), 64 * 1024), /exceeds 65536 bytes/);
  const unsafe = bingHtml.replace("https://example.com/article", "http://127.0.0.1/private");
  assert.deepEqual(parseBingResults(unsafe, 5), []);
});
