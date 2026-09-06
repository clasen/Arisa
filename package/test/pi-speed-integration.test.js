import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createModelSpeedController } from "../src/core/agent/model-speed.js";
import { applyConfigDefaults } from "../src/core/config/config-defaults.js";
import { resolveChatModelSelection, resolveChatSpeed } from "../src/core/agent/model-selection.js";
import { createTelegramModelControls } from "../src/transport/telegram/model-controls.js";
import { createTelegramModelCallbackHandler } from "../src/transport/telegram/model-callback.js";

async function createRuntime(t, credential) {
  const directory = await mkdtemp(path.join(tmpdir(), "arisa-pi-speed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (credential) await writeFile(path.join(directory, "auth.json"), JSON.stringify({ "openai-codex": credential }));
  const runtime = await ModelRuntime.create({
    authPath: path.join(directory, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(directory, "models-store.json"),
    refreshOnCreate: false
  });
  return { directory, runtime };
}

test("speed picker updates Astra in place, persists per topic, and closes unchanged selections", async (t) => {
  const { runtime } = await createRuntime(t);
  t.mock.method(ModelRuntime, "create", async () => runtime);
  const config = applyConfigDefaults({ pi: { provider: "openai-codex", model: "gpt-6-astra" } });
  const writes = [];
  const updates = [];
  const replies = [];
  const answers = [];
  const controls = createTelegramModelControls({
    config,
    saveConfig: async (value) => writes.push(structuredClone(value)),
    agentManager: { setModelSpeed: async (...args) => updates.push(args) },
    contextRoute: () => ({ sessionId: "123:topic:7" })
  });
  const ctx = {
    chat: { id: 123 },
    reply: async (...args) => replies.push(args),
    api: { editMessageText: async (...args) => replies.push(args) },
    answerCallbackQuery: async (answer) => answers.push(answer)
  };
  await controls.showSpeedPicker(ctx);
  assert.equal(replies[0][1]?.reply_markup.inline_keyboard[1][0].callback_data, "speed:2");
  const handler = createTelegramModelCallbackHandler({
    ...controls, config,
    authorizeContext: async () => ({ ok: true }),
    contextRoute: () => ({ sessionId: "123:topic:7" }),
    getChatState: () => ({ processing: true })
  });
  ctx.callbackQuery = { data: "speed:1.5", message: { message_id: 456 } };
  await handler(ctx);
  assert.deepEqual(updates, [["123:topic:7", 2]]);
  assert.equal(resolveChatSpeed(writes[0], "123:topic:7"), 2);
  assert.equal(resolveChatSpeed(config, "123:topic:8"), 1);
  assert.equal(resolveChatModelSelection(config, "123:topic:7").sessionRevision, 0);
  ctx.callbackQuery.data = "speed:2";
  await handler(ctx);
  assert.equal(writes.length, 1);
  assert.match(replies.at(-1)[2], /Already using speed 2.0x/);
  ctx.callbackQuery.data = "speed:1";
  await handler(ctx);
  assert.equal(resolveChatSpeed(config, "123:topic:7"), 1);
  assert.equal(answers.at(-1).text, "Speed: 1.0x.");
});

test("Pi SDK sends the selected speed in the actual Codex payload across turns", async (t) => {
  const apiKey = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
  const { directory, runtime } = await createRuntime(t, {
    type: "oauth", access: apiKey, refresh: "test-refresh", expires: Date.now() + 3_600_000
  });
  const model = runtime.getModel("openai-codex", "gpt-6-astra");
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: directory, agentDir: directory, modelRuntime: runtime, model,
    resourceLoader, settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    sessionManager: SessionManager.inMemory(), tools: []
  });
  t.after(() => session.dispose());
  const requests = [];
  const fetch = async (_url, init) => {
    const body = init.headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(init.body).toString("utf8")
      : init.body;
    requests.push(JSON.parse(body));
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
      id: "test-response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  t.mock.method(globalThis, "fetch", fetch);
  const sdkStream = session.agent.streamFunction;
  const controller = createModelSpeedController((model, context, options) => sdkStream(model, context, {
    ...options, transport: "sse", maxRetries: 0
  }), 1);
  session.agent.streamFunction = controller.streamFn;
  for (const speed of [1, 1.5, 2, 1]) {
    controller.setSpeed(speed);
    await session.prompt("Reply OK");
    const message = session.messages.at(-1);
    assert.equal(message.stopReason, "stop", message.errorMessage);
    assert.equal(requests.at(-1).model, model.id);
    assert.equal(requests.at(-1).service_tier, speed > 1 ? "priority" : "default");
  }
  assert.equal(requests.length, 4);
});

test("speed control leaves unsupported provider payloads and hooks untouched", async () => {
  const options = { onPayload: (payload) => payload };
  let received;
  const controller = createModelSpeedController((_model, _context, nextOptions) => { received = nextOptions; }, 1.5);
  controller.streamFn({ provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-5" }, {}, options);
  assert.equal(received, options);
});

test("Arisa creates and reuses Telegram sessions and opens its TUI with the installed Pi SDK", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "arisa-pi-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { mkdir, writeFile } from "node:fs/promises";
    import path from "node:path";
    import { applyConfigDefaults } from "./src/core/config/config-defaults.js";
    import { AgentManager } from "./src/core/agent/agent-manager.js";
    import { createArisaTuiRuntime } from "./src/runtime/tui.js";
    import { selectChatSpeed } from "./src/core/agent/model-selection.js";
    import { ensureArisaHome, piAuthFile } from "./src/platform/paths.js";
    globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
    await ensureArisaHome();
    await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    await writeFile(piAuthFile, JSON.stringify({ "openai-codex": {
      type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600000
    } }));
    const config = applyConfigDefaults({
      telegram: { authorizedChatIds: [123] },
      pi: { provider: "openai-codex", model: "gpt-6-astra", speed: 1.5, workspaceDir: process.env.ARISA_HOME }
    });
    const manager = new AgentManager({ config });
    manager.setCapabilityService({ execute: async () => ({}) });
    const context = await manager.getSessionContext("123", {});
    try {
      assert.equal(context.session.model.id, "gpt-6-astra");
      assert.equal(context.session.agent.streamFunction, context.speedController.streamFn);
      assert.equal(context.speedController.speed, 2);
      await manager.setModelSpeed("123", 1);
      selectChatSpeed(config, "123", 1);
      const reused = await manager.getSessionContext("123", {});
      assert.equal(reused.session, context.session);
      assert.equal(reused.speedController.speed, 1);
      await reused.release();
    } finally {
      await context.release();
      manager.clearSessionCache("123");
      await Promise.all(manager.sessionClosePromises.values());
      manager.turnCoordinator.close();
    }
    const tui = await createArisaTuiRuntime({ config, client: {} });
    try {
      assert.equal(tui.session.model.id, "gpt-6-astra");
      assert.equal(typeof tui.session.agent.streamFunction, "function");
    } finally {
      await tui.dispose();
    }
  `], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ARISA_HOME: directory, PI_CODING_AGENT_DIR: path.join(directory, "pi"), PI_OFFLINE: "1" },
    timeout: 15_000
  });
});
