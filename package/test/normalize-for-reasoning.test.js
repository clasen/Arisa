import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeArtifactForReasoning,
  selectPipeTool,
  shouldNormalizeArtifactToText
} from "../src/core/artifacts/normalize-for-reasoning.js";

function createToolRegistry(tools, run = async () => ({ ok: true, output: { text: "transcript" } })) {
  return {
    list: () => tools,
    run
  };
}

test("normalizes only audio and video artifacts to text", () => {
  assert.equal(shouldNormalizeArtifactToText({ mimeType: "audio/ogg; codecs=opus" }), true);
  assert.equal(shouldNormalizeArtifactToText({ mimeType: "video/mp4" }), true);
  assert.equal(shouldNormalizeArtifactToText({ mimeType: "text/plain" }), false);
  assert.equal(shouldNormalizeArtifactToText({ mimeType: "image/png" }), false);
  assert.equal(shouldNormalizeArtifactToText({ mimeType: "audio/ogg" }, "application/json"), false);
});

test("selects an audio transcription pipe by MIME input/output and tool description", () => {
  const toolRegistry = createToolRegistry([
    {
      name: "generic-converter",
      description: "Converts things",
      input: ["audio/*"],
      output: ["text/plain"]
    },
    {
      name: "whisper-transcribe",
      description: "Speech to text for voice notes",
      input: ["audio/*"],
      output: ["text/plain"]
    }
  ]);

  const tool = selectPipeTool({
    toolRegistry,
    artifact: { mimeType: "audio/ogg; codecs=opus" },
    desiredMimeType: "text/plain"
  });

  assert.equal(tool.name, "whisper-transcribe");
});

test("returns no pipe when no transcription-like tool can produce the desired output", () => {
  const toolRegistry = createToolRegistry([
    {
      name: "generic-converter",
      description: "Converts audio",
      input: ["audio/*"],
      output: ["application/json"]
    },
    {
      name: "text-maker",
      description: "Writes text",
      input: ["text/plain"],
      output: ["text/plain"]
    }
  ]);

  const tool = selectPipeTool({
    toolRegistry,
    artifact: { mimeType: "audio/ogg" },
    desiredMimeType: "text/plain"
  });

  assert.equal(tool, null);
});

test("does not run tools for artifacts that do not need normalization", async () => {
  let runCount = 0;
  const result = await normalizeArtifactForReasoning({
    artifact: { id: "artifact-1", mimeType: "text/plain", text: "hello" },
    toolRegistry: createToolRegistry([], async () => {
      runCount += 1;
      return { ok: true, output: { text: "unused" } };
    }),
    chatArtifactStore: {},
    chatId: "chat-1"
  });

  assert.deepEqual(result, { normalizedArtifact: null, toolResult: null, toolName: "" });
  assert.equal(runCount, 0);
});

test("returns a failed normalization result when no pipe is registered", async () => {
  const result = await normalizeArtifactForReasoning({
    artifact: { id: "artifact-1", mimeType: "audio/ogg" },
    toolRegistry: createToolRegistry([]),
    chatArtifactStore: {},
    chatId: "chat-1"
  });

  assert.equal(result.normalizedArtifact, null);
  assert.equal(result.toolName, "");
  assert.equal(result.toolResult.ok, false);
  assert.match(result.toolResult.error, /No registered tool can normalize audio\/ogg to text\/plain/);
});

test("creates a text artifact from successful normalization output", async () => {
  const calls = [];
  const createdArtifacts = [];
  const artifact = { id: "voice-1", mimeType: "audio/ogg" };
  const toolRegistry = createToolRegistry([
    {
      name: "openai-transcribe",
      description: "Transcription for audio",
      input: ["audio/*"],
      output: ["text/plain"]
    }
  ], async (request) => {
    calls.push(request);
    return { ok: true, output: { text: "hello from voice" } };
  });
  const chatArtifactStore = {
    createText: async (request) => {
      const created = { id: "text-1", ...request };
      createdArtifacts.push(created);
      return created;
    }
  };

  const result = await normalizeArtifactForReasoning({
    artifact,
    toolRegistry,
    chatArtifactStore,
    chatId: "chat-1"
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    name: "openai-transcribe",
    request: { artifact, args: {} },
    chatId: "chat-1"
  });
  assert.deepEqual(result.normalizedArtifact, createdArtifacts[0]);
  assert.equal(result.toolName, "openai-transcribe");
  assert.deepEqual(createdArtifacts[0], {
    id: "text-1",
    text: "hello from voice",
    mimeType: "text/plain",
    source: { type: "tool", toolName: "openai-transcribe" },
    metadata: { fromArtifactId: "voice-1", tool: "openai-transcribe", normalization: true }
  });
});

test("fails normalization when the selected tool returns no text", async () => {
  const result = await normalizeArtifactForReasoning({
    artifact: { id: "voice-1", mimeType: "audio/ogg" },
    toolRegistry: createToolRegistry([
      {
        name: "openai-transcribe",
        description: "Transcription for audio",
        input: ["audio/*"],
        output: ["text/plain"]
      }
    ], async () => ({ ok: true, output: {} })),
    chatArtifactStore: {},
    chatId: "chat-1"
  });

  assert.equal(result.normalizedArtifact, null);
  assert.equal(result.toolName, "openai-transcribe");
  assert.deepEqual(result.toolResult, {
    ok: false,
    status: "failed",
    error: "Normalization returned no text."
  });
});
