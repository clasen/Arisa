import assert from "node:assert/strict";
import test from "node:test";
import { rankToolMatches } from "../src/core/tools/tool-registry.js";
import { searchOfficialToolCatalog } from "../src/core/tools/official-tool-catalog.js";

const tools = [
  {
    name: "x-reader",
    description: "Read public X posts",
    category: "social",
    keywords: ["posts", "reader", "x"],
    input: ["text/plain"],
    output: ["application/json"]
  },
  {
    name: "x-session-reader",
    description: "Read posts and bookmarks from an X session",
    category: "social",
    keywords: ["bookmarks", "session", "x"],
    input: ["application/json"],
    output: ["application/json", "text/csv"]
  }
];

test("capability search ranks exact keyword matches first", () => {
  const matches = rankToolMatches(tools, "bookmarks");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].tool.name, "x-session-reader");
  assert.equal(matches[0].score, 12);
});

test("capability search covers descriptions, inputs, and outputs", () => {
  assert.equal(rankToolMatches(tools, "public")[0].tool.name, "x-reader");
  assert.equal(rankToolMatches(tools, "csv")[0].tool.name, "x-session-reader");
});

test("official catalog fallback ranks remote manifests", async () => {
  const responses = new Map([
    ["https://api.github.com/repos/clasen/Arisa/contents/tools", [
      { name: "x-reader", type: "dir" },
      { name: "x-session-reader", type: "dir" }
    ]],
    ["https://raw.githubusercontent.com/clasen/Arisa/main/tools/x-reader/tool.manifest.json", tools[0]],
    ["https://raw.githubusercontent.com/clasen/Arisa/main/tools/x-session-reader/tool.manifest.json", tools[1]]
  ]);
  const fetchImpl = async (url) => ({
    ok: responses.has(url),
    status: responses.has(url) ? 200 : 404,
    json: async () => responses.get(url)
  });
  const matches = await searchOfficialToolCatalog("bookmarks", { fetchImpl });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].name, "x-session-reader");
  assert.equal(matches[0].source, "official-catalog");
});
