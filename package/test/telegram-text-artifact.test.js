import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompt, buildReactionPrompt, isScheduledTaskPrompt, scheduledPromptSpeedOptions, shouldIncludeArtifactReference, withPromptSpeed } from "../src/transport/telegram/bot.js";
import { captureIncomingArtifact } from "../src/transport/telegram/media.js";

test("scheduled agent prompts use normal speed for one turn and restore chat speed", async () => {
  let speed = 1.5;
  const speedController = {
    setSpeed(value) { speed = value; }
  };
  assert.equal(isScheduledTaskPrompt("Scheduled task fired.\ntaskId: one"), true);
  assert.equal(isScheduledTaskPrompt("Incoming Telegram message."), false);

  const speedOptions = scheduledPromptSpeedOptions({
    prompt: "Scheduled task fired.\ntaskId: one",
    session: {
      model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.5" }
    },
    speedController,
    configuredSpeed: 1.5
  });
  assert.equal(speedOptions.speed, 1);
  assert.equal(speedOptions.restoreSpeed(), 1.5);

  await withPromptSpeed(speedOptions, async () => {
    assert.equal(speed, 1);
  });
  assert.equal(speed, 1.5);

  await assert.rejects(
    withPromptSpeed({ speedController, speed: 1, restoreSpeed: () => 1.5 }, async () => {
      assert.equal(speed, 1);
      throw new Error("failed turn");
    }),
    /failed turn/
  );
  assert.equal(speed, 1.5);
});

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

test("surfaces Telegram forwarding provenance in the prompt", () => {
  const ctx = createTextContext("forwarded text");
  ctx.message.forward_origin = {
    type: "user",
    sender_user: { id: 999, username: "source_user", first_name: "Source" },
    date: 1_786_570_000
  };

  const prompt = buildPrompt({ ctx });

  assert.match(prompt, /forwarded: true/);
  assert.match(prompt, /forwardedOriginType: user/);
  assert.match(prompt, /forwardedFrom: @source_user/);
  assert.match(prompt, /forwardedAt: 2026-/);
});

test("surfaces Telegram selected quote text when the replied message has no body", () => {
  const ctx = createTextContext("update that too");
  ctx.message.reply_to_message = {
    message_id: 824,
    from: { username: "ArisaWaybot" }
  };
  ctx.message.quote = { text: "master-slave 0.1.9" };

  const prompt = buildPrompt({ ctx });

  assert.match(prompt, /quotedMessageId: 824/);
  assert.match(prompt, /quotedSelection: master-slave 0\.1\.9/);
  assert.doesNotMatch(prompt, /no textual body available/);
});

test("surfaces quoted Telegram forum topic metadata", () => {
  const ctx = createTextContext("continue here");
  ctx.message.reply_to_message = {
    message_id: 824,
    from: { username: "ArisaWaybot" },
    forum_topic_created: { name: "storybot" }
  };

  const prompt = buildPrompt({ ctx });

  assert.match(prompt, /quotedKind: forum_topic_created/);
  assert.match(prompt, /quotedTopicName: storybot/);
  assert.doesNotMatch(prompt, /no textual body available/);
});

test("formats Telegram reaction changes as lightweight feedback", () => {
  const prompt = buildReactionPrompt({
    reaction: {
      chat: { id: 123 },
      user: { id: 456, username: "martin", first_name: "Martin" },
      message_id: 321,
      old_reaction: [{ type: "emoji", emoji: "👍" }],
      new_reaction: [{ type: "emoji", emoji: "❤️" }]
    },
    reactedMessageText: "Updated draft intro"
  });

  assert.match(prompt, /reactedMessageId: 321/);
  assert.match(prompt, /reactedMessageText: Updated draft intro/);
  assert.match(prompt, /addedReactions: ❤️/);
  assert.match(prompt, /removedReactions: 👍/);
  assert.match(prompt, /otherwise stay silent/);
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
