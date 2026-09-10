import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createTelegramAuthController } from "../src/transport/telegram/telegram-auth-controller.js";

function setup(t, { stored = true, apiKey = "", failure = null, loginFailure = null } = {}) {
  const messages = [];
  const calls = { login: 0, validate: 0, clear: 0 };
  t.mock.method(ModelRuntime, "create", async () => ({
    setRuntimeApiKey: async () => {},
    getProviderAuthStatus: () => ({ configured: stored, source: "stored" }),
    getProvider: () => ({ auth: { oauth: {} } }),
    async login() {
      calls.login++;
      if (loginFailure) throw loginFailure;
      return { type: "oauth", access: "test-only" };
    }
  }));
  const controller = createTelegramAuthController({
    config: { pi: { provider: "openai-codex", model: "test-model", apiKey } },
    api: { sendMessage: async (_chatId, text) => messages.push(text) },
    agentManager: {
      async validateAgent() {
        calls.validate++;
        if (failure) throw failure;
      },
      clearSessionCache() { calls.clear++; }
    }
  });
  const command = () => controller.handleCommand({
    chat: { id: 123 }, reply: async (text) => messages.push(text)
  }, { authorize: async () => ({ ok: true }), withTyping: async (_ctx, fn) => fn() });
  return { controller, messages, calls, command };
}

for (const apiKey of ["", "test-key"]) {
  for (const message of [
    "Codex error: The usage limit has been reached",
    "429 Too many requests",
    "insufficient_quota",
    "request timed out",
    "503 service unavailable"
  ]) {
    test(`validation preserves usable auth after ${message} (${apiKey ? "API key" : "OAuth"})`, async (t) => {
      const { controller, calls, command, messages } = setup(t, { apiKey, failure: new Error(message) });
      await command();
      assert.equal(controller.getIssue(), null);
      assert.equal(calls.login, 0);
      assert.equal(calls.clear, 0);
      assert.match(messages[0], new RegExp(message));
      assert.doesNotMatch(messages[0], /Send \/auth|Run \/auth|Update the key|not ready/);
      await command();
      assert.equal(calls.validate, 2);
      assert.equal(calls.login, 0);
    });
  }
}

test("/auth validates stored OAuth credentials instead of starting a device login", async (t) => {
  const { controller, calls, command, messages } = setup(t);
  await command();
  assert.equal(calls.validate, 1);
  assert.equal(calls.login, 0);
  assert.equal(controller.getIssue(), null);
  assert.match(messages[0], /authentication is working/);
});

test("real token invalidation remains blocking and permits OAuth recovery", async (t) => {
  const { controller, command, calls, messages } = setup(t, { failure: new Error("auth token revoked") });
  await command();
  assert.equal(controller.getIssue()?.kind, "invalidated-token");
  assert.match(messages[0], /Run \/auth/);
  await command();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.login, 1);
  assert.equal(controller.getIssue()?.kind, "invalidated-token");
});

test("successful OAuth renewal followed by quota failure clears a stale auth block", async (t) => {
  const { controller, command, calls, messages } = setup(t, {
    failure: new Error("Codex error: The usage limit has been reached")
  });
  controller.rememberIssue(new Error("auth token expired"));
  await command();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.login, 1);
  assert.equal(calls.clear, 1);
  assert.equal(controller.getIssue(), null);
  assert.equal(controller.hasActiveRenewal(123), false);
  assert.match(messages.join("\n"), /signing in again does not restore quota/);
  await command();
  assert.equal(calls.login, 1);
  assert.equal(calls.validate, 2);
});

test("missing credentials still initiate login", async (t) => {
  const { controller, command, calls } = setup(t, { stored: false });
  await command();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.login, 1);
  assert.equal(calls.validate, 1);
  assert.equal(controller.getIssue(), null);
});

test("transient OAuth login failure does not create an authentication block", async (t) => {
  const { controller, command, calls, messages } = setup(t, {
    stored: false, loginFailure: new Error("request timed out")
  });
  await command();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.validate, 0);
  assert.equal(controller.getIssue(), null);
  assert.equal(controller.hasActiveRenewal(123), false);
  assert.match(messages.join("\n"), /does not establish an authentication failure/);
});

test("ordinary prompt quota errors never latch the auth issue", async (t) => {
  const { controller, messages } = setup(t);
  assert.equal(await controller.notifyIssueIfNeeded(123, new Error("Codex error: The usage limit has been reached")), false);
  assert.equal(controller.getIssue(), null);
  assert.equal(messages.length, 0);
  assert.equal(await controller.notifyIssueIfNeeded(123, new Error("No auth found")), true);
  assert.equal(controller.getIssue()?.kind, "missing-auth");
});
