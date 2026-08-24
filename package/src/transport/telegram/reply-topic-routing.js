const replyTopicMarkerPattern = /\s*\[\[ARISA_REPLY_TOPIC:(\d+)\]\]\s*$/u;
const anyReplyTopicMarkerPattern = /\s*\[\[ARISA_REPLY_TOPIC:[^\]]*\]\]\s*$/u;

function singleLine(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function workspaceReplyTopics(config, transportChatId, generalTopicId = 1) {
  const configured = config.telegram?.ownerWorkspaceGroups?.[String(transportChatId)]?.replyTopics;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) return [];

  return Object.entries(configured)
    .map(([rawThreadId, topic]) => ({
      threadId: Number(rawThreadId),
      name: singleLine(topic?.name, 80),
      description: singleLine(topic?.description, 240)
    }))
    .filter((topic) => Number.isSafeInteger(topic.threadId)
      && topic.threadId > 0
      && topic.threadId !== generalTopicId
      && topic.name)
    .sort((left, right) => left.threadId - right.threadId)
    .slice(0, 32);
}

export function buildGeneralReplyRoutingInstruction(topics = []) {
  if (!topics.length) return "";
  const options = topics.map((topic) => [
    `- ${topic.threadId}: ${topic.name}`,
    topic.description ? ` — ${topic.description}` : ""
  ].join(""));
  return [
    "Telegram reply routing instruction:",
    "This message was written in the General topic. The original message must stay there and the conversation remains in the General session.",
    "If, and only if, your final response clearly belongs to exactly one topic below, append [[ARISA_REPLY_TOPIC:<id>]] as the final line. Do not mention this routing marker.",
    "If the relationship is weak, ambiguous, or no topic fits, do not append a marker and the response will remain in General.",
    "Available reply topics:",
    ...options
  ].join("\n");
}

export function appendGeneralReplyRoutingInstruction(prompt, topics = []) {
  const instruction = buildGeneralReplyRoutingInstruction(topics);
  return instruction ? `${String(prompt || "")}\n\n${instruction}` : String(prompt || "");
}

export function extractReplyTopic(text, topics = []) {
  const value = String(text || "");
  const match = value.match(replyTopicMarkerPattern);
  const cleanedText = value.replace(match ? replyTopicMarkerPattern : anyReplyTopicMarkerPattern, "").trimEnd();
  if (!match) return { text: cleanedText, threadId: null };

  const threadId = Number(match[1]);
  const allowed = topics.some((topic) => topic.threadId === threadId);
  return { text: cleanedText, threadId: allowed ? threadId : null };
}

export function routeGeneralWorkspaceReply({ config, route, text }) {
  const isGeneralWorkspaceMessage = route?.workspace
    && route.threadId == null
    && route.topicThreadId === route.generalTopicId;
  if (!isGeneralWorkspaceMessage) {
    return { text: extractReplyTopic(text, []).text, route, topic: null };
  }

  const topics = workspaceReplyTopics(config, route.transportChatId, route.generalTopicId);
  const extracted = extractReplyTopic(text, topics);
  const topic = topics.find((item) => item.threadId === extracted.threadId) || null;
  if (!topic) return { text: extracted.text, route, topic: null };
  return {
    text: extracted.text,
    route: {
      ...route,
      threadId: topic.threadId,
      topicThreadId: topic.threadId
    },
    topic
  };
}
