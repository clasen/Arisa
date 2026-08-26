import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getChatTelegramWorkspacesFile } from "../../platform/paths.js";

const recentProposalWindowMs = 30 * 24 * 60 * 60 * 1000;

function emptyState() {
  return { version: 1, groups: {} };
}

function integer(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function oneLine(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeState(parsed) {
  if (!parsed || parsed.version !== 1 || !parsed.groups || typeof parsed.groups !== "object") {
    throw new Error("Unsupported Telegram workspace topic state");
  }
  return parsed;
}

async function readState(file) {
  try {
    return normalizeState(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

async function writeState(file, state) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

function workspace(state, groupChatId) {
  const groupKey = String(groupChatId);
  state.groups[groupKey] ||= { topics: {}, proposals: {} };
  state.groups[groupKey].topics ||= {};
  state.groups[groupKey].proposals ||= {};
  return state.groups[groupKey];
}

function normalizeTopic(threadId, topic) {
  return {
    threadId: Number(threadId),
    name: oneLine(topic?.name, 80),
    description: oneLine(topic?.description, 240),
    status: topic?.status === "closed" ? "closed" : "open",
    source: oneLine(topic?.source, 40),
    createdAt: oneLine(topic?.createdAt, 40),
    updatedAt: oneLine(topic?.updatedAt, 40)
  };
}

export async function migrateLegacyReplyTopics(config, store) {
  let migratedGroups = 0;
  for (const [groupChatId, workspaceConfig] of Object.entries(config.telegram?.ownerWorkspaceGroups || {})) {
    const configured = workspaceConfig?.replyTopics;
    if (!configured || typeof configured !== "object" || Array.isArray(configured)) continue;
    const generalTopicId = Number(workspaceConfig.generalTopicId) || 1;
    for (const [threadId, topic] of Object.entries(configured)) {
      const numericThreadId = Number(threadId);
      const name = oneLine(topic?.name, 80);
      if (!Number.isSafeInteger(numericThreadId) || numericThreadId <= 0 || numericThreadId === generalTopicId || !name) continue;
      await store.upsertTopic(workspaceConfig.ownerChatId, Number(groupChatId), {
        threadId: numericThreadId,
        name,
        description: topic?.description,
        source: "legacy-config-migration"
      });
    }
    delete workspaceConfig.replyTopics;
    migratedGroups += 1;
  }
  return migratedGroups;
}

export class WorkspaceTopicStore {
  constructor({ resolveFile = getChatTelegramWorkspacesFile, now = () => Date.now() } = {}) {
    this.resolveFile = resolveFile;
    this.now = now;
    this.queues = new Map();
  }

  async withOwnerLock(ownerChatId, work) {
    const key = String(ownerChatId);
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.queues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }

  async read(ownerChatId) {
    await (this.queues.get(String(ownerChatId)) || Promise.resolve()).catch(() => {});
    return readState(this.resolveFile(ownerChatId));
  }

  async listTopics(ownerChatId, groupChatId, { includeClosed = false } = {}) {
    const state = await this.read(ownerChatId);
    const group = state.groups[String(groupChatId)];
    if (!group?.topics) return [];
    return Object.entries(group.topics)
      .map(([threadId, topic]) => normalizeTopic(threadId, topic))
      .filter((topic) => Number.isSafeInteger(topic.threadId)
        && topic.threadId > 0
        && topic.name
        && (includeClosed || topic.status === "open"))
      .sort((left, right) => left.threadId - right.threadId);
  }

  async upsertTopic(ownerChatId, groupChatId, { threadId, name, description, status = "open", source = "observed" }) {
    const scopedOwner = integer(ownerChatId, "ownerChatId");
    const scopedGroup = integer(groupChatId, "groupChatId");
    const scopedThread = integer(threadId, "threadId");
    const scopedName = oneLine(name, 80);
    if (scopedThread <= 0) throw new Error("threadId must be positive");
    if (!scopedName) throw new Error("topic name is required");

    return this.withOwnerLock(scopedOwner, async () => {
      const file = this.resolveFile(scopedOwner);
      const state = await readState(file);
      const group = workspace(state, scopedGroup);
      const key = String(scopedThread);
      const existing = group.topics[key] || {};
      const timestamp = new Date(this.now()).toISOString();
      group.topics[key] = {
        ...existing,
        name: scopedName,
        description: description === undefined ? oneLine(existing.description, 240) : oneLine(description, 240),
        status: status === "closed" ? "closed" : "open",
        source: oneLine(source, 40) || oneLine(existing.source, 40) || "observed",
        createdAt: existing.createdAt || timestamp,
        updatedAt: timestamp
      };
      await writeState(file, state);
      return normalizeTopic(key, group.topics[key]);
    });
  }

  async setTopicStatus(ownerChatId, groupChatId, threadId, status) {
    const scopedOwner = integer(ownerChatId, "ownerChatId");
    const scopedGroup = integer(groupChatId, "groupChatId");
    const scopedThread = integer(threadId, "threadId");
    return this.withOwnerLock(scopedOwner, async () => {
      const file = this.resolveFile(scopedOwner);
      const state = await readState(file);
      const topic = state.groups[String(scopedGroup)]?.topics?.[String(scopedThread)];
      if (!topic) return null;
      topic.status = status === "closed" ? "closed" : "open";
      topic.updatedAt = new Date(this.now()).toISOString();
      await writeState(file, state);
      return normalizeTopic(scopedThread, topic);
    });
  }

  async observeMessage(route, message = {}) {
    if (!route?.workspace || !route.ownerChatId || !route.transportChatId) return null;
    const threadId = route.topicThreadId;
    if (!Number.isSafeInteger(threadId) || threadId === route.generalTopicId) return null;
    if (message.forum_topic_created?.name) {
      return this.upsertTopic(route.ownerChatId, route.transportChatId, {
        threadId,
        name: message.forum_topic_created.name,
        source: "telegram-created"
      });
    }
    if (message.forum_topic_edited?.name) {
      return this.upsertTopic(route.ownerChatId, route.transportChatId, {
        threadId,
        name: message.forum_topic_edited.name,
        source: "telegram-edited"
      });
    }
    if (message.forum_topic_closed) {
      return this.setTopicStatus(route.ownerChatId, route.transportChatId, threadId, "closed");
    }
    if (message.forum_topic_reopened) {
      return this.setTopicStatus(route.ownerChatId, route.transportChatId, threadId, "open");
    }
    return null;
  }

  async recordProposal(ownerChatId, groupChatId, name) {
    const scopedOwner = integer(ownerChatId, "ownerChatId");
    const scopedGroup = integer(groupChatId, "groupChatId");
    const scopedName = oneLine(name, 80);
    if (!scopedName) return null;
    return this.withOwnerLock(scopedOwner, async () => {
      const file = this.resolveFile(scopedOwner);
      const state = await readState(file);
      const group = workspace(state, scopedGroup);
      const key = scopedName.toLocaleLowerCase("en-US");
      group.proposals[key] = {
        name: scopedName,
        proposedAt: new Date(this.now()).toISOString()
      };
      const ordered = Object.entries(group.proposals)
        .sort((left, right) => String(right[1]?.proposedAt || "").localeCompare(String(left[1]?.proposedAt || "")))
        .slice(0, 50);
      group.proposals = Object.fromEntries(ordered);
      await writeState(file, state);
      return group.proposals[key];
    });
  }

  async listRecentProposals(ownerChatId, groupChatId) {
    const state = await this.read(ownerChatId);
    const proposals = state.groups[String(groupChatId)]?.proposals || {};
    const cutoff = this.now() - recentProposalWindowMs;
    return Object.values(proposals)
      .filter((proposal) => Date.parse(proposal?.proposedAt || "") >= cutoff)
      .sort((left, right) => String(right.proposedAt).localeCompare(String(left.proposedAt)))
      .slice(0, 12);
  }
}
