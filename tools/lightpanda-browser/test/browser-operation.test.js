import test from "node:test";
import assert from "node:assert/strict";
import { buildFetchArgs, extractPublicLinks, performBrowse } from "../browser-operation.js";

const publicLookup = async () => [{ address: "93.184.216.34" }];
const config = { TIMEOUT_MS: 20_000, MAX_OUTPUT_BYTES: 2048, OBEY_ROBOTS: true };

function fakeExecution(payload, overrides = {}) {
  return async () => ({ code: 0, signal: null, timedOut: false, stdout: JSON.stringify(payload), stderr: "", ...overrides });
}

test("builds a bounded robots-aware private-network-blocking command", () => {
  const result = buildFetchArgs(new URL("https://example.com/"), "open", config, {});
  assert.deepEqual(result.command.slice(0, 4), ["fetch", "https://example.com/", "--json", "--dump"]);
  assert.ok(result.command.includes("--obey-robots"));
  assert.ok(result.command.includes("--block-private-networks"));
  assert.ok(result.command.includes("--dump-max-bytes"));
  assert.ok(result.command.includes("--v8-max-heap-mb"));
  assert.ok(result.command.includes("--wait-ms"));
});

test("specific waits are not shadowed by the default fixed wait", () => {
  const selector = buildFetchArgs(new URL("https://example.com/"), "open", config, { waitSelector: "#ready" });
  assert.ok(selector.command.includes("--wait-selector"));
  assert.equal(selector.command.includes("--wait-ms"), false);
  const state = buildFetchArgs(new URL("https://example.com/"), "open", config, { waitUntil: "networkidle" });
  assert.ok(state.command.includes("--wait-until"));
  assert.equal(state.command.includes("--wait-ms"), false);
  assert.throws(() => buildFetchArgs(new URL("https://example.com/"), "open", config, { waitUntil: "forever" }), /waitUntil is invalid/);
});

test("open returns rendered markdown and bounded metadata", async () => {
  const output = await performBrowse({
    input: "https://example.com/",
    mode: "open",
    config,
    binary: "/state/lightpanda",
    lookup: publicLookup,
    execute: fakeExecution({ url: "https://example.com/", http_status: 200, content: "# rendered", error: null })
  });
  assert.equal(output.text, "# rendered");
  assert.deepEqual(output.json, { engine: "lightpanda", mode: "open", url: "https://example.com/", status: 200, truncated: false, bytes: 10 });
});

test("render bounds the rendered DOM by UTF-8 bytes", async () => {
  const output = await performBrowse({
    input: "https://example.com/",
    mode: "render",
    config: { ...config, MAX_OUTPUT_BYTES: 1024 },
    binary: "/state/lightpanda",
    lookup: publicLookup,
    execute: fakeExecution({ url: "https://example.com/", http_status: 200, content: `<main>${"á".repeat(2000)}</main>`, error: null })
  });
  assert.equal(output.json.truncated, true);
  assert.ok(Buffer.byteLength(output.text) <= 1024);
  assert.equal(output.text.includes("�"), false);
});

test("extract-links resolves, deduplicates, and excludes non-public literal links", async () => {
  const html = `<a href="/one#part">one</a><a href="/one">duplicate</a><a href="https://other.example/two">two</a><a href="http://127.0.0.1/private">private</a><a href="mailto:a@example.com">mail</a>`;
  const output = await performBrowse({
    input: "https://example.com/base",
    mode: "extract-links",
    config,
    args: { maxLinks: 10 },
    binary: "/state/lightpanda",
    lookup: publicLookup,
    execute: fakeExecution({ url: "https://example.com/base", http_status: 200, content: html, error: null })
  });
  assert.deepEqual(output.json.links, ["https://example.com/one", "https://other.example/two"]);
  assert.match(output.text, /example\.com\/one/);
  assert.equal(extractPublicLinks(html, "https://example.com/base", 1).length, 1);
});

test("navigation failures are explicit and never request automatic fallback", async () => {
  await assert.rejects(
    performBrowse({
      input: "https://example.com/",
      mode: "open",
      config,
      binary: "/state/lightpanda",
      lookup: publicLookup,
      execute: fakeExecution({ url: "https://example.com/", error: "navigation_not_implemented" }, { code: 1 })
    }),
    (error) => error.code === "LIGHTPANDA_PAGE_FAILED" && /select another browser explicitly/.test(error.message)
  );
});
