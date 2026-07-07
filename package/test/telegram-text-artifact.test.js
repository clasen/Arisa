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

function createLocationContext({ location, venue } = {}) {
  return {
    chat: { id: 123 },
    from: { id: 456, username: "martin" },
    msg: { message_id: 789 },
    message: {
      message_id: 789,
      location: location || { latitude: 40.4168, longitude: -3.7038 },
      ...(venue ? { venue } : {})
    }
  };
}

test("turns a shared Telegram location into a processable text artifact", async () => {
  const artifactStore = {
    forChat: () => ({
      createText: async (request) => ({ id: "artifact-1", kind: "text", mimeType: "text/plain", ...request })
    })
  };

  const artifact = await captureIncomingArtifact(createLocationContext(), artifactStore);

  assert.match(artifact.text, /Latitude: 40\.4168/);
  assert.match(artifact.text, /Longitude: -3\.7038/);
  assert.match(artifact.text, /Maps: https:\/\/maps\.google\.com\/\?q=40\.4168,-3\.7038/);
});

test("includes venue title and address when a location is shared as a venue", async () => {
  const artifactStore = {
    forChat: () => ({
      createText: async (request) => ({ id: "artifact-1", kind: "text", mimeType: "text/plain", ...request })
    })
  };

  const ctx = createLocationContext({
    venue: { title: "Cafe Tortoni", address: "Av. de Mayo 825", location: { latitude: -34.6083, longitude: -58.3712 } }
  });

  const artifact = await captureIncomingArtifact(ctx, artifactStore);

  assert.match(artifact.text, /Venue: Cafe Tortoni/);
  assert.match(artifact.text, /Address: Av\. de Mayo 825/);
  assert.match(artifact.text, /Latitude: -34\.6083/);
});

test("surfaces shared location coordinates inline in the agent prompt", () => {
  const ctx = createLocationContext();
  const prompt = buildPrompt({
    ctx,
    artifact: {
      id: "artifact-1",
      kind: "text",
      mimeType: "text/plain",
      text: "Latitude: 40.4168\nLongitude: -3.7038\nMaps: https://maps.google.com/?q=40.4168,-3.7038"
    }
  });

  assert.match(prompt, /text: Latitude: 40\.4168/);
  assert.doesNotMatch(prompt, /artifactId: artifact-1/);
});
