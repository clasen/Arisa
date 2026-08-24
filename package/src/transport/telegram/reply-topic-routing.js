const replyTopicMarkerPattern = /\s*\[\[ARISA_REPLY_TOPIC:(\d+)\]\]\s*$/u;
const proposalMarkerPattern = /\s*\[\[ARISA_PROPOSE_TOPIC:([^\]\r\n]{1,80})\]\]\s*$/u;
const anyRoutingMarkerPattern = /\s*\[\[ARISA_(?:REPLY_TOPIC|PROPOSE_TOPIC):[^\]]*\]\]\s*$/u;

function singleLine(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function isGeneralWorkspaceRoute(route) {
  return Boolean(route?.workspace
    && route.threadId == null
    && route.topicThreadId === route.generalTopicId);
}

function activeTopics(topics = []) {
  return topics
    .map((topic) => ({
      threadId: Number(topic?.threadId),
      name: singleLine(topic?.name, 80),
      description: singleLine(topic?.description, 240)
    }))
    .filter((topic) => Number.isSafeInteger(topic.threadId) && topic.threadId > 0 && topic.name)
    .sort((left, right) => left.threadId - right.threadId)
    .slice(0, 32);
}

export function buildGeneralReplyRoutingInstruction(topics = [], recentProposals = []) {
  const available = activeTopics(topics);
  const options = available.length
    ? available.map((topic) => [
      `- ${topic.threadId}: ${topic.name}`,
      topic.description ? ` — ${topic.description}` : ""
    ].join(""))
    : ["- No named topics are registered yet."];
  const proposals = recentProposals
    .map((proposal) => singleLine(proposal?.name, 80))
    .filter(Boolean)
    .slice(0, 12);
  return [
    "Telegram General-topic management instruction:",
    "This applies only because the incoming message was written in General inside an owner workspace supergroup. It never applies to a private chat with the bot.",
    "The original message must stay in General and the conversation remains in the General session.",
    "If, and only if, your final response clearly belongs to exactly one registered topic below, append [[ARISA_REPLY_TOPIC:<id>]] as the final line. Do not mention this routing marker.",
    "If the relationship is weak, ambiguous, or no topic fits, do not append a reply marker and the response will remain in General.",
    "You may occasionally propose a new topic only when the General conversation shows a substantial theme recurring across multiple turns and no registered topic fits. Ask for explicit confirmation in the visible response and append [[ARISA_PROPOSE_TOPIC:<short name>]] as the final line. Never create a topic without explicit confirmation.",
    proposals.length ? `Do not repeat these recent topic proposals: ${proposals.join(", ")}.` : null,
    "Registered reply topics:",
    ...options
  ].filter(Boolean).join("\n");
}

export function appendGeneralReplyRoutingInstruction(prompt, topics = [], recentProposals = []) {
  return `${String(prompt || "")}\n\n${buildGeneralReplyRoutingInstruction(topics, recentProposals)}`;
}

export function extractReplyTopicMetadata(text, topics = []) {
  let cleanedText = String(text || "");
  let requestedThreadId = null;
  let proposal = "";
  let changed = true;
  while (changed) {
    changed = false;
    const replyMatch = cleanedText.match(replyTopicMarkerPattern);
    if (replyMatch) {
      requestedThreadId ??= Number(replyMatch[1]);
      cleanedText = cleanedText.replace(replyTopicMarkerPattern, "");
      changed = true;
      continue;
    }
    const proposalMatch = cleanedText.match(proposalMarkerPattern);
    if (proposalMatch) {
      proposal ||= singleLine(proposalMatch[1], 80);
      cleanedText = cleanedText.replace(proposalMarkerPattern, "");
      changed = true;
      continue;
    }
    if (anyRoutingMarkerPattern.test(cleanedText)) {
      cleanedText = cleanedText.replace(anyRoutingMarkerPattern, "");
      changed = true;
    }
  }

  const available = activeTopics(topics);
  const allowed = available.some((topic) => topic.threadId === requestedThreadId);
  return {
    text: cleanedText.trimEnd(),
    threadId: allowed ? requestedThreadId : null,
    proposal
  };
}

export function routeGeneralWorkspaceReply({ route, text, topics = [] }) {
  const generalWorkspaceRoute = isGeneralWorkspaceRoute(route);
  const extracted = extractReplyTopicMetadata(text, generalWorkspaceRoute ? topics : []);
  if (!generalWorkspaceRoute) {
    return { text: extracted.text, route, topic: null, proposal: "" };
  }

  const topic = activeTopics(topics).find((item) => item.threadId === extracted.threadId) || null;
  if (!topic) return { text: extracted.text, route, topic: null, proposal: extracted.proposal };
  return {
    text: extracted.text,
    route: {
      ...route,
      threadId: topic.threadId,
      topicThreadId: topic.threadId
    },
    topic,
    proposal: ""
  };
}
