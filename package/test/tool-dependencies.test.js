import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectToolDependencies,
  normalizeToolDependencies,
  resolveToolDependencyPlan,
  satisfiesToolVersion
} from "../src/core/tools/tool-dependencies.js";

test("normalizes strict tool dependency maps and supports exact and caret versions", () => {
  assert.deepEqual(normalizeToolDependencies({ "mcp-client": "^0.1.0" }), { "mcp-client": "^0.1.0" });
  assert.equal(satisfiesToolVersion("0.1.9", "^0.1.0"), true);
  assert.equal(satisfiesToolVersion("0.2.0", "^0.1.0"), false);
  assert.equal(satisfiesToolVersion("1.4.0", "^1.2.3"), true);
  assert.equal(satisfiesToolVersion("2.0.0", "^1.2.3"), false);
  assert.throws(() => normalizeToolDependencies({ "../bad": "^1.0.0" }), /Invalid tool dependency name/);
  assert.throws(() => normalizeToolDependencies({ valid: ">=1.0.0" }), /Unsupported tool dependency range/);
});

test("resolves dependencies before dependents and detects invalid graphs", () => {
  const entries = {
    "mcp-client": { version: "0.1.0", toolDependencies: {} },
    "magnific-mcp": { version: "0.1.0", toolDependencies: { "mcp-client": "^0.1.0" } }
  };
  assert.deepEqual(resolveToolDependencyPlan(entries, "magnific-mcp"), ["mcp-client", "magnific-mcp"]);
  assert.throws(
    () => resolveToolDependencyPlan({ a: { version: "1.0.0", toolDependencies: { b: "^1.0.0" } } }, "a"),
    /not locked/
  );
  assert.throws(
    () => resolveToolDependencyPlan({
      a: { version: "1.0.0", toolDependencies: { b: "^1.0.0" } },
      b: { version: "1.0.0", toolDependencies: { a: "^1.0.0" } }
    }, "a"),
    /Circular/
  );
});

test("reports missing and incompatible installed tool dependencies", () => {
  const tools = new Map([
    ["magnific-mcp", { name: "magnific-mcp", version: "0.1.0", toolDependencies: { "mcp-client": "^0.1.0" } }]
  ]);
  assert.deepEqual(inspectToolDependencies(tools), [{
    tool: "magnific-mcp",
    type: "missing",
    dependency: "mcp-client",
    range: "^0.1.0"
  }]);
  tools.set("mcp-client", { name: "mcp-client", version: "0.2.0", toolDependencies: {} });
  assert.equal(inspectToolDependencies(tools)[0].type, "incompatible");
  tools.get("mcp-client").version = "0.1.4";
  assert.deepEqual(inspectToolDependencies(tools), []);
});
