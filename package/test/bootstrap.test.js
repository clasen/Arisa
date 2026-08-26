import assert from "node:assert/strict";
import test from "node:test";
import { buildConfig } from "../src/runtime/bootstrap.js";
import {
  buildBootstrapConfig,
  parseYesNo,
  selectByIndex,
  selectPiLoginOption,
  sortBootstrapModels,
  sortBootstrapProviders
} from "../src/runtime/bootstrap-config.js";


test("bootstrap facade preserves the shared config builder", () => {
  assert.equal(buildConfig, buildBootstrapConfig);
  const config = buildConfig({
    telegramApiKey: "telegram-token",
    telegramMaxChatIds: 2,
    authorizedChatIds: [123],
    chatMeta: { 123: { languageCode: "es" } },
    provider: "openai-codex",
    model: "gpt-5.5",
    piApiKey: "pi-key"
  });

  assert.equal(config.telegram.token, "telegram-token");
  assert.equal(config.telegram.maxChatIds, 2);
  assert.deepEqual(config.telegram.authorizedChatIds, [123]);
  assert.equal(config.pi.provider, "openai-codex");
  assert.equal(config.pi.model, "gpt-5.5");
  assert.equal(config.pi.apiKey, "pi-key");
});

test("shared bootstrap policy keeps provider and model ordering stable", () => {
  const providers = [
    { provider: "anthropic" },
    { provider: "openai-codex" },
    { provider: "google" }
  ];
  assert.deepEqual(
    sortBootstrapProviders(providers).map((item) => item.provider),
    ["openai-codex", "anthropic", "google"]
  );
  assert.deepEqual(providers.map((item) => item.provider), ["anthropic", "openai-codex", "google"]);

  const models = [{ id: "older" }, { id: "gpt-5.5" }, { id: "newer" }];
  assert.deepEqual(
    sortBootstrapModels("openai-codex", models).map((item) => item.id),
    ["gpt-5.5", "newer", "older"]
  );
  assert.equal(selectByIndex(models, "99"), models[2]);
});

test("shared bootstrap input policy preserves localized yes/no and login preference", () => {
  assert.equal(parseYesNo("sí"), true);
  assert.equal(parseYesNo("no"), false);
  assert.equal(parseYesNo("maybe"), null);
  assert.equal(parseYesNo("", false), false);

  const selected = selectPiLoginOption([
    { id: "browser", label: "Browser OAuth" },
    { id: "device", label: "Device code" }
  ]);
  assert.equal(selected.id, "device");
});
