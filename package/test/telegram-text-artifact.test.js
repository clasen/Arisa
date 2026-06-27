import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompt, shouldIncludeArtifactReference } from "../src/transport/telegram/bot.js";
import { captureIncomingArtifact } from "../src/transport/telegram/media.js";

function createTextContext(text = "hello") {
  return {
    chat: { id: 123 },
    from: { id: 456, username: "martin" },
    msg: { message_id: 789 },
    message: {
      message_id: 789,
      text
    }
  };
}

test("does not expose inline message text artifacts as prompt attachments", () => {
  const prompt = buildPrompt({
    ctx: createTextContext("hello"),
    artifact: {
      id: "artifact-1",
      kind: "text",
      mimeType: "text/plain",
      text: "hello"
    }
  });

  assert.match(prompt, /text: hello/);
  assert.doesNotMatch(prompt, /artifactId: artifact-1/);
  assert.doesNotMatch(prompt, /mimeType: text\/plain/);
  assert.doesNotMatch(prompt, /kind: text/);
});

test("keeps distinct artifacts visible to the prompt", () => {
  assert.equal(
    shouldIncludeArtifactReference({
      artifact: {
        id: "artifact-1",
        kind: "document",
        mimeType: "text/plain",
        path: "/tmp/note.txt"
      },
      messageText: "see attached"
    }),
    true
  );

  assert.equal(
    shouldIncludeArtifactReference({
      artifact: {
        id: "artifact-2",
        kind: "text",
        mimeType: "text/plain",
        text: "different text"
      },
      messageText: "hello"
    }),
    true
  );
});

test("marks incoming Telegram text artifacts as internal inline messages", async () => {
  const calls = [];
  const artifactStore = {
    forChat: (chatId) => ({
      createText: async (request) => {
        calls.push({ chatId, ...request });
        return { id: "artifact-1", chatId, kind: "text", mimeType: "text/plain", ...request };
      }
    })
  };

  const artifact = await captureIncomingArtifact(createTextContext("hello"), artifactStore);

  assert.equal(artifact.text, "hello");
  assert.deepEqual(calls[0].metadata, {
    visibility: "internal",
    representation: "inline-message"
  });
});
