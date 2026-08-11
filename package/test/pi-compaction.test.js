import test from "node:test";
import assert from "node:assert/strict";
import { createPiSettingsManager } from "../src/core/agent/agent-manager.js";
import { applyConfigDefaults, piConfigDefaults } from "../src/core/config/config-defaults.js";

test("provides Pi compaction defaults through Arisa config", () => {
  const config = applyConfigDefaults({ pi: {} });

  assert.deepEqual(config.pi.compaction, {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000
  });
  assert.deepEqual(config.pi.compaction, piConfigDefaults.compaction);
});

test("merges partial Pi compaction overrides with defaults", () => {
  const config = applyConfigDefaults({
    pi: { compaction: { reserveTokens: 8_192 } }
  });

  assert.deepEqual(config.pi.compaction, {
    enabled: true,
    reserveTokens: 8_192,
    keepRecentTokens: 20_000
  });
});

test("passes Arisa compaction config to Pi settings", () => {
  const config = applyConfigDefaults({
    pi: {
      compaction: {
        enabled: false,
        reserveTokens: 12_000,
        keepRecentTokens: 18_000
      }
    }
  });

  const settingsManager = createPiSettingsManager(config);

  assert.deepEqual(settingsManager.getCompactionSettings(), config.pi.compaction);
});
