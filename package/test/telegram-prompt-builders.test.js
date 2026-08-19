import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStartupMessage,
  normalizeIncomingArtifact
} from "../src/transport/telegram/prompt-builders.js";

test("builds localized Telegram startup messages", () => {
  assert.equal(buildStartupMessage({ languageCode: "es-AR" }), "Arisa esta en linea de nuevo.");
  assert.equal(buildStartupMessage({ languageCode: "pt-BR" }), "Arisa esta online de novo.");
  assert.equal(buildStartupMessage({ languageCode: "en" }), "Arisa is back online.");
});

test("reports whether an incoming artifact required normalization", async () => {
  const result = await normalizeIncomingArtifact({
    artifact: { id: "voice-1", mimeType: "audio/ogg" },
    toolRegistry: { list: () => [] },
    chatArtifactStore: {},
    chatId: "chat-1"
  });

  assert.equal(result.normalizationRequired, true);
  assert.equal(result.transcript, null);
  assert.match(result.toolResult.error, /No registered tool can normalize audio\/ogg to text\/plain/);
});

test("skips normalization metadata when there is no incoming artifact", async () => {
  assert.deepEqual(await normalizeIncomingArtifact({}), {
    transcript: null,
    toolResult: null,
    normalizationRequired: false
  });
});
