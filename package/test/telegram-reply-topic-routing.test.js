import test from "node:test";
import assert from "node:assert/strict";
import {
  appendGeneralReplyRoutingInstruction,
  extractReplyTopic,
  routeGeneralWorkspaceReply,
  workspaceReplyTopics
} from "../src/transport/telegram/reply-topic-routing.js";

const config = {
  telegram: {
    ownerWorkspaceGroups: {
      "-100123": {
        ownerChatId: 42,
        generalTopicId: 1,
        replyTopics: {
          "23": { name: "Stories", description: "Published stories and editorial work" },
          "87": { name: "CBPR", description: "Castle Bravo press campaign" },
          "1": { name: "General" },
          nope: { name: "Invalid" },
          "114": { name: "CORE", description: "Arisa core engineering" }
        }
      }
    }
  }
};

const generalRoute = {
  workspace: true,
  ownerChatId: 42,
  sessionId: "42",
  scopeChatId: 42,
  transportChatId: -100123,
  threadId: null,
  topicThreadId: 1,
  generalTopicId: 1
};

test("workspace reply topics are bounded, validated, and exclude General", () => {
  assert.deepEqual(workspaceReplyTopics(config, -100123, 1), [
    { threadId: 23, name: "Stories", description: "Published stories and editorial work" },
    { threadId: 87, name: "CBPR", description: "Castle Bravo press campaign" },
    { threadId: 114, name: "CORE", description: "Arisa core engineering" }
  ]);
});

test("General prompts describe conservative reply-only topic routing", () => {
  const topics = workspaceReplyTopics(config, -100123, 1);
  const prompt = appendGeneralReplyRoutingInstruction("Incoming Telegram message.", topics);
  assert.match(prompt, /original message must stay there/);
  assert.match(prompt, /23: Stories/);
  assert.match(prompt, /87: CBPR/);
  assert.match(prompt, /114: CORE/);
  assert.match(prompt, /relationship is weak, ambiguous/);
});

test("an allowed trailing marker is stripped and selects its topic", () => {
  const topics = workspaceReplyTopics(config, -100123, 1);
  assert.deepEqual(extractReplyTopic("Implemented.\n[[ARISA_REPLY_TOPIC:114]]", topics), {
    text: "Implemented.",
    threadId: 114
  });
});

test("invalid markers are stripped without rerouting", () => {
  const topics = workspaceReplyTopics(config, -100123, 1);
  assert.deepEqual(extractReplyTopic("Keep this here.\n[[ARISA_REPLY_TOPIC:999]]", topics), {
    text: "Keep this here.",
    threadId: null
  });
});

test("only replies originating in General can change visual destination", () => {
  const routed = routeGeneralWorkspaceReply({
    config,
    route: generalRoute,
    text: "Core update.\n[[ARISA_REPLY_TOPIC:114]]"
  });
  assert.equal(routed.text, "Core update.");
  assert.equal(routed.route.sessionId, "42");
  assert.equal(routed.route.threadId, 114);
  assert.equal(routed.topic.name, "CORE");

  const topicRoute = { ...generalRoute, sessionId: "topic-23", threadId: 23, topicThreadId: 23 };
  const unchanged = routeGeneralWorkspaceReply({
    config,
    route: topicRoute,
    text: "Already in Stories.\n[[ARISA_REPLY_TOPIC:114]]"
  });
  assert.equal(unchanged.route, topicRoute);
  assert.equal(unchanged.topic, null);
  assert.equal(unchanged.text, "Already in Stories.");
});
