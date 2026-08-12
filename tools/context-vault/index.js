import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile, readdir } from "node:fs/promises";
import DeepBase from "deepbase";
import defaults from "./config.js";

const toolName = "context-vault";
const require = createRequire(import.meta.url);

async function getArisaPackageDir() {
  if (process.env.ARISA_PACKAGE_DIR) return process.env.ARISA_PACKAGE_DIR;
  return (await readFile(path.join(os.homedir(), ".arisa", "arisa-package-dir"), "utf8")).trim();
}

async function importCore(relativePath) {
  return import(pathToFileURL(path.join(await getArisaPackageDir(), "src", relativePath)).href);
}

const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { createDaemonRuntime } = await importCore("core/tools/daemon-runtime.js");
const { readDaemonLaunchContext } = await importCore("core/tools/daemon-processes.js");
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");
const { getChatPiSessionsDir, getChatToolStateDir, getToolStateDir } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`context-vault

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions via args.action:
  remember        Store a memory. args: text, category?, tags?, importance?
  recall          Hybrid semantic and lexical search. args: query?, category?, tags?, limit?, fallbackSessions?
  facts           List current memories. args: category?, limit?
  rules           List rule/preference memories.
  search-sessions Search prior Pi sessions. args: query?, limit?
  find-contact    Find contact details in memory, then prior Pi sessions. args: query?, limit?
  promote         Store text found elsewhere as memory. args: text, category?, tags?, importance?
  forget          Delete a memory by args.id.
  update          Update a memory by args.id plus text/category/tags/importance.
  reindex         Rebuild the derived SeekMix semantic index from the memory vault.
  status          Show memory count and semantic index configuration.

DeepBase remains the source of truth. SeekMix 1.4 provides a derived multilingual
semantic index in a warm chat-scoped daemon; recall reranks semantic candidates with
lexical overlap, importance, and recency.
`);
}

function now() { return new Date().toISOString(); }
function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function truthy(value) { return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase()); }
function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "").split(/[,#]/).map((item) => item.trim()).filter(Boolean);
}
function memoryText(request) {
  return String(request.args?.text || request.args?.memory || request.text || request.artifact?.text || "").trim();
}
function memorySemanticId(id) { return `memory:${id}`; }
function semanticTags(memory) {
  return ["context-memory", `category:${memory.category || "fact"}`, ...(memory.tags || []).map((tag) => `tag:${tag}`)];
}

function runtimeFor(chatId) {
  return createDaemonRuntime({
    toolName,
    entryPath: fileURLToPath(import.meta.url),
    scope: { type: "chat", chatId: String(chatId) },
    startupContext: { chatId: String(chatId) },
    autoStart: true
  });
}

async function openDb(chatId) {
  if (!chatId) throw new Error("chatId is required");
  const stateDir = getChatToolStateDir(String(chatId), toolName);
  await mkdir(stateDir, { recursive: true });
  const db = new DeepBase({ path: stateDir, name: "vault" });
  await db.connect();
  return { db, stateDir };
}

async function createContext(chatId, config) {
  const { db, stateDir } = await openDb(chatId);
  const modelDir = path.join(getToolStateDir(toolName), "models");
  await mkdir(modelDir, { recursive: true });
  const { SeekMix, HuggingfaceProvider } = require("seekmix");
  const provider = new HuggingfaceProvider({
    model: String(config.MODEL || defaults.MODEL),
    dtype: String(config.DTYPE || defaults.DTYPE),
    pipelineOptions: { cache_dir: modelDir }
  });
  const store = new SeekMix({
    dbPath: path.join(stateDir, "semantic.db"),
    ttl: -1,
    similarityThreshold: asNumber(config.MIN_SIMILARITY, asNumber(defaults.MIN_SIMILARITY, 0.55)),
    embeddingProvider: provider
  });
  await store.connect();
  return { chatId: String(chatId), config, db, store, provider, modelDir, stateDir };
}

async function allMemories(db) {
  const entries = await db.entries("memories").catch(() => []);
  return entries.map(([id, value]) => ({ id, ...value })).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function lexicalMatch(memory, { query = "", category = "", tags = [] }) {
  const haystack = [memory.text, memory.category, ...(memory.tags || [])].join(" ").toLowerCase();
  const terms = termsFromQuery(query);
  if (category && memory.category !== category) return false;
  if (tags.length && !tags.every((tag) => (memory.tags || []).includes(tag))) return false;
  return terms.every((term) => haystack.includes(term));
}

function formatMemory(memory) {
  const tags = memory.tags?.length ? ` #${memory.tags.join(" #")}` : "";
  return `- ${memory.id} [${memory.category || "fact"}]${tags}: ${memory.text}`;
}
function formatList(memories) {
  if (!memories.length) return "No context memories found.";
  return memories.map(formatMemory).join("\n");
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    if (typeof block.text === "string") return block.text;
    if (typeof block.name === "string" && block.arguments) return `${block.name} ${JSON.stringify(block.arguments)}`;
    if (typeof block.type === "string" && typeof block.result === "string") return block.result;
    return "";
  }).filter(Boolean).join("\n");
}

function sessionEntryText(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (entry.type === "session") return [entry.id, entry.cwd].filter(Boolean).join(" ");
  if (entry.type === "model_change" || entry.type === "thinking_level_change") return "";
  const message = entry.message || {};
  const role = typeof message.role === "string" ? message.role : entry.type || "entry";
  const text = textFromContent(message.content) || textFromContent(entry.content) || String(entry.text || "");
  return text.trim() ? `${role}: ${text}` : "";
}

function termsFromQuery(query) {
  return String(query || "").toLowerCase().split(/\s+/).map((term) => term.replace(/^\p{P}+|\p{P}+$/gu, "").trim()).filter((term) => term.length > 1);
}
function scoreText(text, terms) {
  const lower = text.toLowerCase();
  if (!terms.length) return 1;
  let score = 0;
  for (const term of terms) if (lower.includes(term)) score += term.length;
  return score;
}
function compactSnippet(text, terms, size = 360) {
  const clean = text.replace(/\s+/g, " ").trim();
  const lower = clean.toLowerCase();
  const firstHit = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstHit - Math.floor(size / 3));
  const snippet = clean.slice(start, start + size);
  return `${start > 0 ? "…" : ""}${snippet}${start + size < clean.length ? "…" : ""}`;
}

async function sessionFiles(chatId) {
  const dir = getChatPiSessionsDir(String(chatId));
  const names = await readdir(dir).catch(() => []);
  return names.filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name));
}

async function searchSessions(request, config) {
  const query = String(request.args?.query || request.text || "").trim();
  const terms = termsFromQuery(query);
  const limit = asNumber(request.args?.limit, asNumber(config.MAX_RESULTS, defaults.MAX_RESULTS));
  const results = [];
  for (const file of await sessionFiles(request.chatId)) {
    const raw = await readFile(file, "utf8").catch(() => "");
    if (!raw) continue;
    raw.split(/\r?\n/).filter(Boolean).forEach((line, index) => {
      let entry;
      try { entry = JSON.parse(line); } catch { return; }
      const text = sessionEntryText(entry);
      if (!text) return;
      const score = scoreText(text, terms);
      if (score <= 0) return;
      results.push({ file, line: index + 1, timestamp: entry.timestamp || null, score, snippet: compactSnippet(text, terms), text });
    });
  }
  results.sort((a, b) => b.score - a.score || String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
  const top = results.slice(0, limit).map(({ text, ...item }) => item);
  const text = top.length ? top.map((hit, index) => `${index + 1}. ${path.basename(hit.file)}:${hit.line}${hit.timestamp ? ` ${hit.timestamp}` : ""}\n${hit.snippet}`).join("\n\n") : "No prior Pi session matches found.";
  return { text, json: { query, results: top } };
}

function contactMatches(text) {
  const matches = new Set();
  const patterns = [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, /\+\d[\d\s().-]{7,}\d/g, /\b\d{10,}@(c\.us|lid)\b/g, /\b(?:54|549)\d{9,13}\b/g];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) matches.add(match[0].trim());
  return [...matches].filter((item) => item.length >= 8);
}

async function findContact(context, request) {
  const query = String(request.args?.query || request.text || "").trim();
  const terms = termsFromQuery(query);
  const limit = asNumber(request.args?.limit, asNumber(context.config.MAX_RESULTS, defaults.MAX_RESULTS));
  const recalled = await recall(context, { ...request, args: { ...request.args, query, limit: Math.max(limit * 3, 10) } });
  const memories = recalled.json.memories.filter((memory) => contactMatches(memory.text).length).slice(0, limit);
  if (memories.length) return { text: formatList(memories), json: { source: "memory", memories } };
  const contacts = [];
  for (const file of await sessionFiles(request.chatId)) {
    const raw = await readFile(file, "utf8").catch(() => "");
    if (!raw) continue;
    raw.split(/\r?\n/).filter(Boolean).forEach((line, index) => {
      let entry;
      try { entry = JSON.parse(line); } catch { return; }
      const text = sessionEntryText(entry);
      const values = contactMatches(text);
      if (!values.length) return;
      const baseScore = scoreText(text, terms);
      for (const value of values) {
        const isEmail = value.includes("@");
        const isWhatsappId = /@(c\.us|lid)\b/.test(value);
        const isPhone = value.startsWith("+") || /^\d{10,}$/.test(value);
        const queryWantsWhatsapp = terms.some((term) => ["whatsapp", "wpp", "wa"].includes(term));
        const typeScore = isWhatsappId ? 40 : isPhone ? 30 : isEmail ? 18 : 5;
        contacts.push({ value, file, line: index + 1, timestamp: entry.timestamp || null, score: baseScore + typeScore + (queryWantsWhatsapp && (isWhatsappId || isPhone) ? 40 : 0), snippet: compactSnippet(text, terms) });
      }
    });
  }
  contacts.sort((a, b) => b.score - a.score || String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
  const unique = [];
  const seen = new Set();
  for (const contact of contacts) {
    const key = contact.value.replace(/\D/g, "") || contact.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(contact);
  }
  const top = unique.slice(0, limit);
  const text = top.length ? top.map((item, index) => `${index + 1}. ${item.value} (${path.basename(item.file)}:${item.line})\n${item.snippet}`).join("\n\n") : "No contact details found in memory or prior Pi sessions.";
  return { text, json: { source: "sessions", contacts: top } };
}

async function indexMemory(store, id, memory) {
  const semanticId = memorySemanticId(id);
  const current = await store.getById(semanticId);
  if (current?.content === memory.text && current?.data?.updatedAt === memory.updatedAt) return false;
  await store.upsert({ id: semanticId, content: memory.text, data: { id, updatedAt: memory.updatedAt }, tags: semanticTags(memory), expiresAt: null });
  return true;
}

async function syncSemanticIndex(context, memories) {
  let indexed = 0;
  for (const memory of memories) if (await indexMemory(context.store, memory.id, memory)) indexed += 1;
  return indexed;
}

function lexicalOverlap(memory, terms) {
  if (!terms.length) return 0;
  const haystack = [memory.text, memory.category, ...(memory.tags || [])].join(" ").toLowerCase();
  return terms.filter((term) => haystack.includes(term)).length / terms.length;
}
function recencyScore(memory) {
  const timestamp = Date.parse(memory.updatedAt || memory.createdAt || "");
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86400000);
  return Math.max(0, 1 - ageDays / 365);
}

async function semanticCandidates(context, memories, query, category, tags, limit) {
  const indexed = await syncSemanticIndex(context, memories);
  const filters = ["context-memory"];
  if (category) filters.push(`category:${category}`);
  for (const tag of tags) filters.push(`tag:${tag}`);
  const candidateLimit = Math.max(5, Math.min(50, Math.max(limit * 3, asNumber(context.config.SEMANTIC_CANDIDATES, defaults.SEMANTIC_CANDIDATES))));
  const matches = await context.store.search(query, { limit: candidateLimit, minSimilarity: asNumber(context.config.MIN_SIMILARITY, defaults.MIN_SIMILARITY), tags: { all: filters } });
  return { indexed, matches };
}

async function recall(context, request) {
  const query = String(request.args?.query || request.text || "").trim();
  const category = String(request.args?.category || "").trim();
  const tags = normalizeTags(request.args?.tags);
  const limit = Math.max(1, asNumber(request.args?.limit, asNumber(context.config.MAX_RESULTS, defaults.MAX_RESULTS)));
  const all = await allMemories(context.db);
  const eligible = all.filter((memory) => (!category || memory.category === category) && (!tags.length || tags.every((tag) => (memory.tags || []).includes(tag))));
  if (!query) {
    const memories = eligible.slice(-limit);
    return { text: formatList(memories), json: { memories, retrieval: { mode: "list" } } };
  }

  const terms = termsFromQuery(query);
  const byId = new Map(eligible.map((memory) => [memory.id, memory]));
  const ranking = new Map();
  let semantic = { indexed: 0, matches: [] };
  let semanticError = null;
  try { semantic = await semanticCandidates(context, eligible, query, category, tags, limit); }
  catch (error) { semanticError = error.message || String(error); }
  for (const hit of semantic.matches) {
    const memory = byId.get(hit.data?.id);
    if (memory) ranking.set(memory.id, { memory, semanticSimilarity: hit.similarity, semanticRank: semantic.matches.indexOf(hit) + 1 });
  }
  for (const memory of eligible.filter((item) => lexicalMatch(item, { query, category, tags }))) {
    if (!ranking.has(memory.id)) ranking.set(memory.id, { memory, semanticSimilarity: 0, semanticRank: null });
  }
  const ranked = [...ranking.values()].map((item) => {
    const overlap = lexicalOverlap(item.memory, terms);
    const importance = Math.max(0, Math.min(5, asNumber(item.memory.importance, 1))) / 5;
    const score = item.semanticSimilarity + overlap * 0.12 + importance * 0.02 + recencyScore(item.memory) * 0.01;
    return { ...item, lexicalOverlap: overlap, score };
  }).sort((a, b) => b.score - a.score || String(b.memory.updatedAt || "").localeCompare(String(a.memory.updatedAt || "")));
  const selected = ranked.slice(0, limit);
  const memories = selected.map((item) => item.memory);
  if (!memories.length && truthy(request.args?.fallbackSessions)) {
    const sessionResult = await searchSessions(request, context.config);
    return { text: `${formatList(memories)}\n\nPrior Pi session fallback:\n${sessionResult.text}`, json: { memories, retrieval: { mode: semanticError ? "lexical-fallback" : "hybrid", semanticError }, sessionFallback: sessionResult.json } };
  }
  return {
    text: formatList(memories),
    json: {
      memories,
      retrieval: {
        mode: semanticError ? "lexical-fallback" : "hybrid",
        semanticIndexed: semantic.indexed,
        semanticCandidates: semantic.matches.length,
        semanticError,
        ranking: selected.map((item) => ({ id: item.memory.id, score: Number(item.score.toFixed(6)), similarity: Number(item.semanticSimilarity.toFixed(6)), semanticRank: item.semanticRank, lexicalOverlap: Number(item.lexicalOverlap.toFixed(3)) }))
      }
    }
  };
}

async function remember(context, request) {
  const text = memoryText(request);
  if (!text) throw new Error("Memory text is required");
  const id = request.args?.id || crypto.randomUUID();
  const memory = { text, category: String(request.args?.category || "fact").trim() || "fact", tags: normalizeTags(request.args?.tags), importance: asNumber(request.args?.importance, 1), createdAt: now(), updatedAt: now(), source: request.args?.source || "user" };
  await context.db.set("memories", id, memory);
  let semanticIndexed = false;
  let semanticError = null;
  try { semanticIndexed = await indexMemory(context.store, id, memory); } catch (error) { semanticError = error.message || String(error); }
  return { text: `Remembered: ${formatMemory({ id, ...memory })}`, json: { id, memory, semanticIndexed, semanticError } };
}

async function updateMemory(context, request) {
  const id = String(request.args?.id || "").trim();
  if (!id) throw new Error("id is required");
  const existing = await context.db.get("memories", id);
  if (!existing) throw new Error(`No memory found for id: ${id}`);
  const updated = { ...existing, text: request.args?.text == null ? existing.text : String(request.args.text).trim(), category: request.args?.category == null ? existing.category : String(request.args.category).trim(), tags: request.args?.tags == null ? existing.tags : normalizeTags(request.args.tags), importance: request.args?.importance == null ? existing.importance : asNumber(request.args.importance, existing.importance || 1), updatedAt: now() };
  await context.db.set("memories", id, updated);
  let semanticIndexed = false;
  let semanticError = null;
  try { semanticIndexed = await indexMemory(context.store, id, updated); } catch (error) { semanticError = error.message || String(error); }
  return { text: `Updated: ${formatMemory({ id, ...updated })}`, json: { id, memory: updated, semanticIndexed, semanticError } };
}

async function forget(context, request) {
  const id = String(request.args?.id || "").trim();
  if (!id) throw new Error("id is required");
  await context.db.del("memories", id);
  let semanticDeleted = false;
  let semanticError = null;
  try { semanticDeleted = await context.store.delete(memorySemanticId(id)); } catch (error) { semanticError = error.message || String(error); }
  return { text: `Forgot memory: ${id}`, json: { id, semanticDeleted, semanticError } };
}

async function reindex(context) {
  await context.store.clear();
  const memories = await allMemories(context.db);
  const indexed = await syncSemanticIndex(context, memories);
  return { text: `Rebuilt semantic memory index with ${indexed} memories.`, json: { memories: memories.length, indexed } };
}

async function status(context) {
  const memories = await allMemories(context.db);
  return { text: `${memories.length} memories; SeekMix ${require("seekmix/package.json").version} with ${context.provider.model} (${context.provider.dimensions} dimensions).`, json: { memories: memories.length, seekmixVersion: require("seekmix/package.json").version, model: context.provider.model, dimensions: context.provider.dimensions, minSimilarity: asNumber(context.config.MIN_SIMILARITY, defaults.MIN_SIMILARITY), semanticCandidates: asNumber(context.config.SEMANTIC_CANDIDATES, defaults.SEMANTIC_CANDIDATES) } };
}

async function processRequest(context, request) {
  const action = String(request.args?.action || "recall").toLowerCase();
  if (action === "remember" || action === "promote") return remember(context, request);
  if (action === "recall" || action === "search") return recall(context, request);
  if (action === "facts" || action === "list") return recall(context, { ...request, args: { ...request.args, query: request.args?.query || "" } });
  if (action === "rules") return recall(context, { ...request, args: { ...request.args, category: "rule", query: "" } });
  if (action === "search-sessions" || action === "sessions") return searchSessions(request, context.config);
  if (action === "find-contact") return findContact(context, request);
  if (action === "forget") return forget(context, request);
  if (action === "update") return updateMemory(context, request);
  if (action === "reindex") return reindex(context);
  if (action === "status") return status(context);
  throw new Error(`Unknown action: ${action}`);
}

async function healthCheck(context) {
  const id = "internal:health";
  const existing = await context.store.getById(id);
  if (!existing) await context.store.upsert({ id, content: "Context Vault semantic health probe", data: { healthy: true }, tags: ["internal-health"], expiresAt: null });
  const results = await context.store.search("semantic health probe", { limit: 1, minSimilarity: -1, tags: { all: ["internal-health"] } });
  if (results[0]?.id !== id) throw new Error("Context Vault semantic search health probe failed");
  return { message: `Context Vault semantic memory is healthy (${context.provider.dimensions} dimensions)` };
}

async function closeContext(context) {
  await context.store.disconnect().catch(() => {});
  if (typeof context.db.disconnect === "function") await context.db.disconnect().catch(() => {});
}

async function runClient(requestFile) {
  try {
    const request = JSON.parse((await readFile(requestFile, "utf8")).replace(/^\uFEFF/, ""));
    if (!request.chatId) throw new Error("chatId is required");
    const config = await loadToolConfig(toolName, defaults, request.chatId);
    const output = await runtimeFor(request.chatId).submit({ request }, { timeoutMs: asNumber(config.JOB_TIMEOUT_MS, defaults.JOB_TIMEOUT_MS), readyTimeoutMs: asNumber(config.READY_TIMEOUT_MS, defaults.READY_TIMEOUT_MS) });
    console.log(JSON.stringify(toolOk(output)));
  } catch (error) {
    console.log(JSON.stringify(toolError(error.message || String(error))));
  }
}

async function runDaemon() {
  const launch = await readDaemonLaunchContext({ expectedToolName: toolName });
  const chatId = launch?.startupContext?.chatId || launch?.scope?.chatId;
  if (!chatId) throw new Error("Chat-scoped daemon launch is missing chatId");
  let config = await loadToolConfig(toolName, defaults, chatId);
  let context = await createContext(chatId, config);
  const daemon = runtimeFor(chatId);
  await daemon.workLoop({
    idleTimeoutMs: asNumber(config.IDLE_TIMEOUT_MS, defaults.IDLE_TIMEOUT_MS),
    processJob: (job) => processRequest(context, job.request),
    healthCheck: () => healthCheck(context),
    recover: async () => {
      await closeContext(context);
      config = await loadToolConfig(toolName, defaults, chatId);
      context = await createContext(chatId, config);
      return true;
    },
    beforeExit: () => closeContext(context)
  });
}

const args = process.argv.slice(2);
if (args[0] === "daemon") await runDaemon();
else if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
else if (args[0] === "run") await runClient(args[args.indexOf("--request-file") + 1]);
else printHelp();
