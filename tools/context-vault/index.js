import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, readdir } from "node:fs/promises";
import DeepBase from "deepbase";
import defaults from "./config.js";

const toolName = "context-vault";

async function getArisaPackageDir() {
  if (process.env.ARISA_PACKAGE_DIR) return process.env.ARISA_PACKAGE_DIR;
  return (await readFile(path.join(os.homedir(), ".arisa", "arisa-package-dir"), "utf8")).trim();
}

async function importCore(relativePath) {
  return import(pathToFileURL(path.join(await getArisaPackageDir(), "src", relativePath)).href);
}

const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { toolError, toolOk } = await importCore("core/tools/tool-result.js");
const { getChatPiSessionsDir, getChatToolStateDir } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`context-vault

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions via args.action:
  remember  Store a memory. args: text, category?, tags?, importance?
  recall          Search memories. args: query?, category?, tags?, limit?, fallbackSessions?
  facts           List current memories. args: category?, limit?
  rules           List rule/preference memories.
  search-sessions Search prior Pi sessions. args: query?, limit?
  find-contact    Find contact details in memory, then prior Pi sessions. args: query?, limit?
  promote         Store text found elsewhere as memory. args: text, category?, tags?, importance?
  forget          Delete a memory by args.id.
  update          Update a memory by args.id plus text/category/tags/importance.

All data is scoped to the current Telegram chat and persisted with DeepBase.
`);
}

function now() {
  return new Date().toISOString();
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "").split(/[,#]/).map((item) => item.trim()).filter(Boolean);
}

function memoryText(request) {
  return String(request.args?.text || request.args?.memory || request.text || request.artifact?.text || "").trim();
}

function asNumber(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function openDb(chatId) {
  if (!chatId) throw new Error("chatId is required");
  const stateDir = getChatToolStateDir(String(chatId), toolName);
  await mkdir(stateDir, { recursive: true });
  const db = new DeepBase({ path: stateDir, name: "vault" });
  await db.connect();
  return db;
}

async function allMemories(db) {
  const entries = await db.entries("memories").catch(() => []);
  return entries.map(([id, value]) => ({ id, ...value })).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function matches(memory, { query = "", category = "", tags = [] }) {
  const haystack = [memory.text, memory.category, ...(memory.tags || [])].join(" ").toLowerCase();
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
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

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
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
  if (!text.trim()) return "";
  return `${role}: ${text}`;
}

function termsFromQuery(query) {
  return String(query || "").toLowerCase().split(/\s+/).map((term) => term.trim()).filter((term) => term.length > 1);
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
  const firstHit = terms.map((term) => lower.indexOf(term)).filter((idx) => idx >= 0).sort((a, b) => a - b)[0] ?? 0;
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
  const files = await sessionFiles(request.chatId);
  const results = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8").catch(() => "");
    if (!raw) continue;
    const lines = raw.split(/\r?\n/).filter(Boolean);
    lines.forEach((line, index) => {
      let entry;
      try { entry = JSON.parse(line); } catch { return; }
      const text = sessionEntryText(entry);
      if (!text) return;
      const score = scoreText(text, terms);
      if (score <= 0) return;
      results.push({
        file,
        line: index + 1,
        timestamp: entry.timestamp || null,
        score,
        snippet: compactSnippet(text, terms),
        text
      });
    });
  }
  results.sort((a, b) => b.score - a.score || String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
  const top = results.slice(0, limit).map(({ text, ...item }) => item);
  const formatted = top.length ? top.map((hit, index) => `${index + 1}. ${path.basename(hit.file)}:${hit.line}${hit.timestamp ? ` ${hit.timestamp}` : ""}\n${hit.snippet}`).join("\n\n") : "No prior Pi session matches found.";
  return { text: formatted, json: { query, results: top } };
}

function contactMatches(text) {
  const matches = new Set();
  const patterns = [
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    /\+\d[\d\s().-]{7,}\d/g,
    /\b\d{10,}@(c\.us|lid)\b/g,
    /\b(?:54|549)\d{9,13}\b/g
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) matches.add(match[0].trim());
  return [...matches].filter((item) => item.length >= 8);
}

async function findContact(db, request, config) {
  const query = String(request.args?.query || request.text || "").trim();
  const terms = termsFromQuery(query);
  const limit = asNumber(request.args?.limit, asNumber(config.MAX_RESULTS, defaults.MAX_RESULTS));
  const memories = (await allMemories(db)).filter((memory) => matches(memory, { query, category: "", tags: [] }) && contactMatches(memory.text).length).slice(-limit);
  if (memories.length) return { text: formatList(memories), json: { source: "memory", memories } };

  const contacts = [];
  for (const file of await sessionFiles(request.chatId)) {
    const raw = await readFile(file, "utf8").catch(() => "");
    if (!raw) continue;
    const lines = raw.split(/\r?\n/).filter(Boolean);
    lines.forEach((line, index) => {
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
        const score = baseScore + typeScore + (queryWantsWhatsapp && (isWhatsappId || isPhone) ? 40 : 0);
        contacts.push({
          value,
          file,
          line: index + 1,
          timestamp: entry.timestamp || null,
          score,
          snippet: compactSnippet(text, terms)
        });
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

async function remember(db, request) {
  const text = memoryText(request);
  if (!text) throw new Error("Memory text is required");
  const id = request.args?.id || crypto.randomUUID();
  const memory = {
    text,
    category: String(request.args?.category || "fact").trim() || "fact",
    tags: normalizeTags(request.args?.tags),
    importance: asNumber(request.args?.importance, 1),
    createdAt: now(),
    updatedAt: now(),
    source: request.args?.source || "user"
  };
  await db.set("memories", id, memory);
  return { text: `Remembered: ${formatMemory({ id, ...memory })}`, json: { id, memory } };
}

async function recall(db, request, config) {
  const query = String(request.args?.query || request.text || "").trim();
  const category = String(request.args?.category || "").trim();
  const tags = normalizeTags(request.args?.tags);
  const limit = asNumber(request.args?.limit, asNumber(config.MAX_RESULTS, defaults.MAX_RESULTS));
  const memories = (await allMemories(db)).filter((memory) => matches(memory, { query, category, tags })).slice(-limit);
  if (!memories.length && truthy(request.args?.fallbackSessions)) {
    const sessionResult = await searchSessions(request, config);
    return { text: `${formatList(memories)}\n\nPrior Pi session fallback:\n${sessionResult.text}`, json: { memories, sessionFallback: sessionResult.json } };
  }
  return { text: formatList(memories), json: { memories } };
}

async function updateMemory(db, request) {
  const id = String(request.args?.id || "").trim();
  if (!id) throw new Error("id is required");
  const existing = await db.get("memories", id);
  if (!existing) throw new Error(`No memory found for id: ${id}`);
  const updated = {
    ...existing,
    text: request.args?.text == null ? existing.text : String(request.args.text).trim(),
    category: request.args?.category == null ? existing.category : String(request.args.category).trim(),
    tags: request.args?.tags == null ? existing.tags : normalizeTags(request.args.tags),
    importance: request.args?.importance == null ? existing.importance : asNumber(request.args.importance, existing.importance || 1),
    updatedAt: now()
  };
  await db.set("memories", id, updated);
  return { text: `Updated: ${formatMemory({ id, ...updated })}`, json: { id, memory: updated } };
}

async function forget(db, request) {
  const id = String(request.args?.id || "").trim();
  if (!id) throw new Error("id is required");
  await db.del("memories", id);
  return { text: `Forgot memory: ${id}`, json: { id } };
}

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const config = await loadToolConfig(toolName, defaults, request.chatId);
  const db = await openDb(request.chatId);
  const action = String(request.args?.action || "recall").toLowerCase();
  if (action === "remember" || action === "promote") return remember(db, request);
  if (action === "recall" || action === "search") return recall(db, request, config);
  if (action === "facts" || action === "list") return recall(db, { ...request, args: { ...request.args, query: request.args?.query || "" } }, config);
  if (action === "rules") return recall(db, { ...request, args: { ...request.args, category: "rule", query: "" } }, config);
  if (action === "search-sessions" || action === "sessions") return searchSessions(request, config);
  if (action === "find-contact") return findContact(db, request, config);
  if (action === "forget") return forget(db, request);
  if (action === "update") return updateMemory(db, request);
  throw new Error(`Unknown action: ${action}`);
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
else if (args[0] === "run") {
  run(args[args.indexOf("--request-file") + 1])
    .then((output) => console.log(JSON.stringify(toolOk(output))))
    .catch((error) => console.log(JSON.stringify(toolError(error.message || String(error)))));
} else printHelp();
