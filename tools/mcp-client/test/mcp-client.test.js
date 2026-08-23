import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isPrivateAddress, validateRemoteUrl } from "../network-security.js";
import { oauthWatchTasks } from "../oauth-watch-plan.js";
import { openCredentials, readState, sealCredentials, writeState } from "../state-store.js";
import { availableTools, remoteArguments, resolveRemoteTool } from "../tool-routing.js";

test("routes discovered MCP tools generically", () => {
  const catalog = availableTools({ tools: [
    { name: "video_generate", inputSchema: { type: "object" } },
    { name: "audio_tts", inputSchema: { type: "object" } }
  ] });
  assert.equal(resolveRemoteTool({ action: "video_generate" }, catalog), "video_generate");
  assert.equal(resolveRemoteTool({ action: "call", tool: "audio_tts" }, catalog), "audio_tts");
  assert.deepEqual(remoteArguments({ action: "video_generate", profile: "magnific", confirm: true, video: { clips: [] } }), { video: { clips: [] } });
  assert.deepEqual(remoteArguments({ action: "call", tool: "audio_tts", arguments: '{"text":"hello"}' }), { text: "hello" });
  assert.throws(() => resolveRemoteTool({ action: "unknown_tool" }, catalog), /does not provide/);
  assert.throws(() => remoteArguments({ arguments: "[]" }), /must be a JSON object/);
});

test("rejects local and private MCP endpoints", async () => {
  await assert.rejects(() => validateRemoteUrl("http://example.com/mcp"), /HTTPS/);
  await assert.rejects(() => validateRemoteUrl("https://127.0.0.1/mcp"), /Private/);
  await assert.rejects(() => validateRemoteUrl("https://localhost/mcp"), /Local/);
  assert.equal(isPrivateAddress("10.0.0.1"), true);
  assert.equal(isPrivateAddress("169.254.1.2"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});

test("allows a public HTTPS MCP endpoint", async () => {
  const url = await validateRemoteUrl("https://mcp.magnific.com/");
  assert.equal(url.href, "https://mcp.magnific.com/");
});

test("plans independent bounded OAuth checks bound to one authorization", () => {
  const now = Date.parse("2026-08-16T20:00:00.000Z");
  const tasks = oauthWatchTasks("magnific", "watch-123", "2026-08-16T20:10:00.000Z", now);
  assert.equal(tasks.length > 10, true);
  assert.equal(tasks.every((task) => task.recurrence == null), true);
  assert.equal(tasks.every((task) => task.payload.args.watchId === "watch-123"), true);
  assert.equal(new Set(tasks.map((task) => task.runAt)).size, tasks.length);
  assert.equal(Date.parse(tasks.at(-1).runAt) < Date.parse("2026-08-16T20:10:00.000Z"), true);
});

test("stores credentials encrypted and state atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-client-test-"));
  const chatState = path.join(root, "chat");
  const globalState = path.join(root, "global");
  try {
    const sealed = await sealCredentials(globalState, { accessToken: "secret-token" });
    assert.equal(JSON.stringify(sealed).includes("secret-token"), false);
    assert.deepEqual(await openCredentials(globalState, sealed), { accessToken: "secret-token" });
    await writeState(chatState, { profiles: { magnific: { endpoint: "https://mcp.magnific.com/", sealedCredentials: sealed } } });
    const raw = await readFile(path.join(chatState, "profiles.json"), "utf8");
    assert.equal(raw.includes("secret-token"), false);
    assert.equal((await readState(chatState)).profiles.magnific.endpoint, "https://mcp.magnific.com/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
