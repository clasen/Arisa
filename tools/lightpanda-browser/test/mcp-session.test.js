import test from "node:test";
import assert from "node:assert/strict";
import { buildMcpCommand, normalizeInteractionSteps } from "../mcp-session.js";

const publicLookup = async () => [{ address: "93.184.216.34" }];

test("normalizes a bounded read-only interaction sequence", async () => {
  const steps = await normalizeInteractionSteps(JSON.stringify([
    { tool: "goto", arguments: { url: "https://example.com" } },
    { tool: "tree", arguments: { maxDepth: 500 } },
    { tool: "markdown", arguments: { selector: "main", maxBytes: 999999 } }
  ]), { lookup: publicLookup });
  assert.equal(steps[0].arguments.url, "https://example.com/");
  assert.equal(steps[1].arguments.maxDepth, 20);
  assert.equal(steps[2].arguments.maxBytes, 131072);
});

test("mutation operations are opt-in and accept selectors or fresh backend node ids", async () => {
  const fill = [{ tool: "fill", arguments: { selector: ".new-todo", value: "test" } }];
  await assert.rejects(normalizeInteractionSteps(fill), /actionLevel=interact/);
  await assert.rejects(normalizeInteractionSteps([{ tool: "click", arguments: {} }], { allowMutations: true }), /selector or backendNodeId/);
  const normalized = await normalizeInteractionSteps(fill, { allowMutations: true });
  assert.equal(normalized[0].tool, "fill");
  assert.deepEqual(normalized[0].arguments, fill[0].arguments);
  assert.equal(normalized[0].actionLevel, "interact");
  const backend = await normalizeInteractionSteps([{ tool: "click", arguments: { backendNodeId: 4 } }], { allowMutations: true });
  assert.deepEqual(backend[0].arguments, { backendNodeId: 4 });
});

test("blocks unsupported capabilities and private navigation", async () => {
  await assert.rejects(normalizeInteractionSteps([{ tool: "evaluate", arguments: { script: "document.cookie" } }]), /unsupported tool/);
  await assert.rejects(normalizeInteractionSteps([{ tool: "goto", arguments: { url: "http://127.0.0.1" } }]), /Private or non-public/);
});

test("authenticated MCP command loads private cookies and required resources", () => {
  const command = buildMcpCommand({ OBEY_ROBOTS: true, AUTHENTICATED_OBEY_ROBOTS: false }, 10_000, {
    authenticated: true,
    cookiePath: "/private/cookies.json",
    cookieJarPath: "/private/jar.json"
  });
  assert.equal(command.includes("--obey-robots"), false);
  assert.deepEqual(command.slice(-8), [
    "--cookie", "/private/cookies.json", "--cookie-jar", "/private/jar.json",
    "--load-resources", "iframe", "--load-resources", "stylesheet"
  ]);
});

test("validates extraction schema and sequence bounds", async () => {
  await assert.rejects(normalizeInteractionSteps([{ tool: "extract", arguments: { schema: "[]" } }]), /JSON object/);
  await assert.rejects(normalizeInteractionSteps(Array.from({ length: 21 }, () => ({ tool: "getUrl" }))), /at most 20/);
  const steps = await normalizeInteractionSteps([{ tool: "extract", arguments: { schema: '{"title":"h1"}' } }]);
  assert.equal(steps[0].arguments.schema, '{"title":"h1"}');
});
