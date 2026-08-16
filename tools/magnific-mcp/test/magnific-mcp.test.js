import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claimDelivery, deliveryClaimed } from "../delivery-claims.js";
import { generationWatchTasks } from "../generation-watch-plan.js";
import { findFirst, findUpload, mcpData } from "../magnific-api.js";
import { publicHttpsUrl } from "../network.js";
import { prunePreparations, readState, writeState } from "../state-store.js";

test("extracts structured MCP data and nested upload targets", () => {
  const result = { ok: true, output: { json: { structuredContent: { credits: { available: 10 } } } } };
  assert.equal(mcpData(result).credits.available, 10);
  const upload = findUpload({ uploads: [{ path: "tmp/a", url: "https://example.com/put" }] });
  assert.equal(upload.path, "tmp/a");
  assert.equal(findFirst({ result: { creationIdentifier: "abc" } }, ["creationIdentifier"]), "abc");
  assert.equal(findFirst({ content: [{ type: "text", text: "status: completed\nurl: \"https://cdn.example/image.jpg?x=1\"" }] }, ["url"]), "https://cdn.example/image.jpg?x=1");
});

test("rejects private transfer URLs", async () => {
  await assert.rejects(() => publicHttpsUrl("http://example.com/file"), /public HTTPS/);
  await assert.rejects(() => publicHttpsUrl("https://127.0.0.1/file"), /private/);
  assert.equal((await publicHttpsUrl("https://mcp.magnific.com/file")).hostname, "mcp.magnific.com");
});

test("plans independent generation checks bound to one job token", () => {
  const now = Date.parse("2026-08-16T20:00:00.000Z");
  const tasks = generationWatchTasks("job-1", "token-1", now, 600);
  assert.equal(tasks.length > 10, true);
  assert.equal(tasks.every((task) => task.recurrence == null), true);
  assert.equal(tasks.every((task) => task.payload.args.jobId === "job-1"), true);
  assert.equal(tasks.every((task) => task.payload.args.watchToken === "token-1"), true);
  assert.equal(new Set(tasks.map((task) => task.runAt)).size, tasks.length);
});

test("atomically blocks concurrent duplicate delivery claims", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "magnific-claims-"));
  try {
    const results = await Promise.allSettled([
      claimDelivery(root, "job-1", 0, "creation-1"),
      claimDelivery(root, "job-1", 0, "creation-1")
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(await deliveryClaimed(root, "job-1", 0), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists and prunes preparations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "magnific-mcp-test-"));
  try {
    await writeState(root, {
      preparations: {
        expired: { expiresAt: "2020-01-01T00:00:00.000Z" },
        live: { expiresAt: "2030-01-01T00:00:00.000Z" }
      },
      jobs: {
        expiredJob: { expiresAt: "2020-01-01T00:00:00.000Z" },
        liveJob: { expiresAt: "2030-01-01T00:00:00.000Z" }
      }
    });
    const state = prunePreparations(await readState(root), Date.parse("2026-01-01T00:00:00.000Z"));
    assert.deepEqual(Object.keys(state.preparations), ["live"]);
    assert.deepEqual(Object.keys(state.jobs), ["liveJob"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
