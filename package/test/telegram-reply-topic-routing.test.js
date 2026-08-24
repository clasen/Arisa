import test from "node:test";
import assert from "node:assert/strict";
import {
  appendGeneralReplyRoutingInstruction,
  extractReplyTopicMetadata,
  isGeneralWorkspaceRoute,
  routeGeneralWorkspaceReply
} from "../src/transport/telegram/reply-topic-routing.js";

const topics = [
  { threadId: 23, name: "Stories", description: "Published stories and editorial work" },
  { threadId: 87, name: "CBPR", description: "Castle Bravo press campaign" },
  { threadId: 114, name: "CORE", description: "Arisa core engineering" }
];

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

test("General prompts describe conservative dynamic reply routing", () => {
  const prompt = appendGeneralReplyRoutingInstruction("Incoming Telegram message.", topics, [
    { name: "Infrastructure", proposedAt: "2026-08-24T00:00:00.000Z" }
  ]);
  assert.match(prompt, /only because the incoming message was written in General/);
  assert.match(prompt, /never applies to a private chat/);
  assert.match(prompt, /original message must stay in General/);
  assert.match(prompt, /23: Stories/);
  assert.match(prompt, /87: CBPR/);
  assert.match(prompt, /114: CORE/);
  assert.match(prompt, /Do not repeat these recent topic proposals: Infrastructure/);
  assert.match(prompt, /Never create a topic without explicit confirmation/);
});

test("an allowed trailing marker is stripped and selects its topic", () => {
  assert.deepEqual(extractReplyTopicMetadata("Implemented.\n[[ARISA_REPLY_TOPIC:114]]", topics), {
    text: "Implemented.",
    threadId: 114,
    proposal: ""
  });
});

test("invalid markers are stripped without rerouting", () => {
  assert.deepEqual(extractReplyTopicMetadata("Keep this here.\n[[ARISA_REPLY_TOPIC:999]]", topics), {
    text: "Keep this here.",
    threadId: null,
    proposal: ""
  });
});

test("topic proposals are stripped and returned as transport metadata", () => {
  assert.deepEqual(extractReplyTopicMetadata("Should we create it?\n[[ARISA_PROPOSE_TOPIC:Research Lab]]", topics), {
    text: "Should we create it?",
    threadId: null,
    proposal: "Research Lab"
  });
});

test("only replies originating in a supergroup General topic can change destination", () => {
  assert.equal(isGeneralWorkspaceRoute(generalRoute), true);
  const routed = routeGeneralWorkspaceReply({
    route: generalRoute,
    topics,
    text: "Core update.\n[[ARISA_REPLY_TOPIC:114]]"
  });
  assert.equal(routed.text, "Core update.");
  assert.equal(routed.route.sessionId, "42");
  assert.equal(routed.route.threadId, 114);
  assert.equal(routed.topic.name, "CORE");

  const privateRoute = {
    workspace: false,
    sessionId: "42",
    scopeChatId: 42,
    transportChatId: 42,
    threadId: null
  };
  assert.equal(isGeneralWorkspaceRoute(privateRoute), false);
  const privateReply = routeGeneralWorkspaceReply({
    route: privateRoute,
    topics,
    text: "Private response.\n[[ARISA_REPLY_TOPIC:114]]"
  });
  assert.equal(privateReply.route, privateRoute);
  assert.equal(privateReply.topic, null);
  assert.equal(privateReply.proposal, "");
  assert.equal(privateReply.text, "Private response.");
});
