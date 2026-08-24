import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  migrateLegacyReplyTopics,
  WorkspaceTopicStore
} from "../src/transport/telegram/workspace-topic-store.js";

async function fixture(now = Date.parse("2026-08-24T12:00:00.000Z")) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arisa-workspace-topics-"));
  const file = path.join(directory, "topics.json");
  return {
    file,
    store: new WorkspaceTopicStore({ resolveFile: () => file, now: () => now }),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

test("workspace topics are learned, renamed, closed, and reopened dynamically", async () => {
  const { store, cleanup } = await fixture();
  try {
    const route = {
      workspace: true,
      ownerChatId: 42,
      transportChatId: -100123,
      topicThreadId: 25,
      generalTopicId: 1
    };
    await store.observeMessage(route, { forum_topic_created: { name: "Research" } });
    assert.equal((await store.listTopics(42, -100123))[0].name, "Research");

    await store.observeMessage(route, { forum_topic_edited: { name: "Research Lab" } });
    assert.equal((await store.listTopics(42, -100123))[0].name, "Research Lab");

    await store.observeMessage(route, { forum_topic_closed: {} });
    assert.deepEqual(await store.listTopics(42, -100123), []);
    assert.equal((await store.listTopics(42, -100123, { includeClosed: true }))[0].status, "closed");

    await store.observeMessage(route, { forum_topic_reopened: {} });
    assert.equal((await store.listTopics(42, -100123))[0].status, "open");
  } finally {
    await cleanup();
  }
});

test("Arisa topic initialization persists semantic context", async () => {
  const { store, cleanup } = await fixture();
  try {
    await store.upsertTopic(42, -100123, {
      threadId: 114,
      name: "CORE",
      description: "Arisa runtime and Telegram engineering",
      source: "arisa-initialized"
    });
    assert.deepEqual((await store.listTopics(42, -100123)).map(({ threadId, name, description, source }) => ({
      threadId,
      name,
      description,
      source
    })), [{
      threadId: 114,
      name: "CORE",
      description: "Arisa runtime and Telegram engineering",
      source: "arisa-initialized"
    }]);
  } finally {
    await cleanup();
  }
});

test("concurrent topic updates preserve every workspace entry", async () => {
  const { store, file, cleanup } = await fixture();
  try {
    await Promise.all(Array.from({ length: 30 }, (_, index) => store.upsertTopic(42, -100123, {
      threadId: index + 2,
      name: `Topic ${index + 2}`
    })));
    assert.equal((await store.listTopics(42, -100123)).length, 30);
    assert.equal(JSON.parse(await readFile(file, "utf8")).version, 1);
  } finally {
    await cleanup();
  }
});

test("legacy configured topics migrate once into dynamic state", async () => {
  const { store, cleanup } = await fixture();
  try {
    const config = {
      telegram: {
        ownerWorkspaceGroups: {
          "-100123": {
            ownerChatId: 42,
            generalTopicId: 1,
            replyTopics: {
              "1": { name: "General" },
              "23": { name: "Stories", description: "Editorial work" }
            }
          }
        }
      }
    };
    assert.equal(await migrateLegacyReplyTopics(config, store), 1);
    assert.equal(config.telegram.ownerWorkspaceGroups["-100123"].replyTopics, undefined);
    assert.deepEqual((await store.listTopics(42, -100123)).map((topic) => topic.name), ["Stories"]);
    assert.equal(await migrateLegacyReplyTopics(config, store), 0);
  } finally {
    await cleanup();
  }
});

test("recent proposals are deduplicated and scoped by supergroup", async () => {
  const { store, cleanup } = await fixture();
  try {
    await store.recordProposal(42, -100123, "Research Lab");
    await store.recordProposal(42, -100123, "research lab");
    await store.recordProposal(42, -100999, "Another Group");
    assert.deepEqual((await store.listRecentProposals(42, -100123)).map((item) => item.name), ["research lab"]);
    assert.deepEqual((await store.listRecentProposals(42, -100999)).map((item) => item.name), ["Another Group"]);
  } finally {
    await cleanup();
  }
});
