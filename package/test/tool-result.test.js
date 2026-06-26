import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeToolResult,
  toolError,
  toolNeedsConfig,
  toolOk
} from "../src/core/tools/tool-result.js";

test("builds standard successful tool responses", () => {
  assert.deepEqual(
    toolOk({ text: "done" }, { asyncTasks: [{ id: "task-1" }] }),
    { ok: true, output: { text: "done" }, asyncTasks: [{ id: "task-1" }] }
  );
});

test("builds standard failed tool responses", () => {
  assert.deepEqual(
    toolError("boom", { status: "bad_request", details: { field: "name" } }),
    {
      ok: false,
      status: "bad_request",
      error: "boom",
      details: { field: "name" }
    }
  );
});

test("builds missing-config tool responses", () => {
  assert.deepEqual(
    toolNeedsConfig({
      tool: "demo",
      missingConfig: ["apiKey"],
      configPath: "/tmp/config.js"
    }),
    {
      ok: false,
      status: "needs_config",
      error: "Missing tool configuration for demo.",
      missingConfig: ["apiKey"],
      configPath: "/tmp/config.js",
      resolution: {
        type: "user_config_required",
        tool: "demo",
        missingConfig: ["apiKey"],
        configPath: "/tmp/config.js"
      }
    }
  );
});

test("normalizes non-object responses into failed results", () => {
  const result = normalizeToolResult("demo", "not-json");

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Invalid tool response for demo");
});

test("normalizes missing-config failures", () => {
  const result = normalizeToolResult("demo", {
    ok: false,
    error: "Need API key",
    missingConfig: ["apiKey"],
    configPath: "/tmp/config.js"
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "needs_config");
  assert.equal(result.error, "Need API key");
  assert.deepEqual(result.resolution, {
    type: "user_config_required",
    tool: "demo",
    missingConfig: ["apiKey"],
    configPath: "/tmp/config.js"
  });
});

test("preserves explicit missing-config status and resolution", () => {
  const result = normalizeToolResult("demo", {
    ok: false,
    status: "blocked",
    error: "Need consent",
    missingConfig: ["consent"],
    resolution: { type: "manual", url: "https://example.com" }
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.resolution, { type: "manual", url: "https://example.com" });
});

test("normalizes regular failures", () => {
  const result = normalizeToolResult("demo", {
    ok: false,
    error: "Tool exploded",
    stdout: "",
    stderr: "stack"
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Tool exploded");
  assert.equal(result.stderr, "stack");
});

test("normalizes successful responses", () => {
  const result = normalizeToolResult("demo", {
    ok: true,
    output: { text: "hello" },
    delivery: { method: "document" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, { text: "hello" });
  assert.deepEqual(result.delivery, { method: "document" });
});

test("rejects object responses without an ok contract", () => {
  const rawResult = { output: { text: "hello" } };
  const result = normalizeToolResult("demo", rawResult);

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Invalid tool response for demo");
  assert.deepEqual(result.rawResult, rawResult);
});
