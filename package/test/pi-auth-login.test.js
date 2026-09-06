import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiOAuthLogin } from "../src/core/agent/pi-auth-login.js";
import { createPiRuntime, hasProviderAuth, supportsProviderOAuth } from "../src/core/agent/pi-runtime.js";
import { piAuthFile } from "../src/platform/paths.js";

test("creates the async Pi runtime with Arisa credential storage and awaits runtime API keys", async (t) => {
  const calls = [];
  const runtime = {
    async setRuntimeApiKey(provider, apiKey) {
      await Promise.resolve();
      calls.push([provider, apiKey]);
    },
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    getProvider: () => ({ auth: { oauth: {} } })
  };
  t.mock.method(ModelRuntime, "create", async (options) => {
    assert.equal(options.authPath, piAuthFile);
    return runtime;
  });
  assert.equal(await createPiRuntime({ provider: "openai", apiKey: "test-key" }), runtime);
  assert.deepEqual(calls, [["openai", "test-key"]]);
  assert.equal(hasProviderAuth("openai", runtime), true);
  assert.equal(supportsProviderOAuth("openai", runtime), true);
});

test("adapts Pi OAuth notifications, selections and manual codes in order", async (t) => {
  const events = [];
  let controller;
  const credential = { type: "oauth", access: "test-access" };
  t.mock.method(ModelRuntime, "create", async () => ({
    getProvider: () => ({ auth: { oauth: {} } }),
    async login(provider, type, interaction) {
      assert.equal(provider, "openai-codex");
      assert.equal(type, "oauth");
      interaction.notify({ type: "auth_url", url: "https://example.com/login" });
      interaction.notify({ type: "device_code", userCode: "ABCD", verificationUri: "https://example.com/device" });
      interaction.notify({ type: "progress", message: "waiting" });
      assert.equal(await interaction.prompt({ type: "select", options: [{ id: "device", label: "Device" }] }), "device");
      assert.deepEqual(events, ["auth", "device", "waiting", "select"]);
      assert.equal(await interaction.prompt({ type: "text", message: "Value" }), "answer");
      const code = interaction.prompt({ type: "manual_code" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(controller.manualInputRequested, true);
      assert.equal(controller.submitManualCode(" callback-code "), true);
      assert.equal(await code, "callback-code");
      return credential;
    }
  }));
  controller = createPiOAuthLogin({
    provider: "openai-codex",
    onAuth: async () => { await Promise.resolve(); events.push("auth"); },
    onDeviceCode: async () => { events.push("device"); },
    onProgress: (message) => events.push(message),
    onSelect: ({ options }) => { events.push("select"); return options[0].id; },
    onPrompt: () => "answer"
  });
  assert.equal(await controller.promise, credential);
  assert.equal(controller.manualInputRequested, false);
  assert.equal(controller.submitManualCode("again"), false);
});

test("OAuth rejects unsupported providers and surfaces notification failures", async (t) => {
  t.mock.method(ModelRuntime, "create", async () => ({ getProvider: () => ({ auth: {} }) }));
  await assert.rejects(createPiOAuthLogin({ provider: "unsupported" }).promise, /No internal OAuth login flow/);
  ModelRuntime.create.mock.restore();
  t.mock.method(ModelRuntime, "create", async () => ({
    getProvider: () => ({ auth: { oauth: {} } }),
    async login(_provider, _type, interaction) {
      interaction.notify({ type: "auth_url", url: "https://example.com/login" });
      await interaction.prompt({ type: "manual_code" });
    }
  }));
  const login = createPiOAuthLogin({ provider: "openai-codex", onAuth: async () => { throw new Error("delivery failed"); } });
  await assert.rejects(login.promise, /delivery failed/);
  assert.equal(login.manualInputRequested, false);
});
