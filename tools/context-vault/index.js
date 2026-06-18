import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
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
const { getChatToolStateDir } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`context-vault

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions via args.action:
  remember  Store a memory. args: text, category?, tags?, importance?
  recall    Search memories. args: query?, category?, tags?, limit?
  facts     List current memories. args: category?, limit?
  rules     List rule/preference memories.
  forget    Delete a memory by args.id.
  update    Update a memory by args.id plus text/category/tags/importance.

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
  if (action === "remember") return remember(db, request);
  if (action === "recall" || action === "search") return recall(db, request, config);
  if (action === "facts" || action === "list") return recall(db, { ...request, args: { ...request.args, query: request.args?.query || "" } }, config);
  if (action === "rules") return recall(db, { ...request, args: { ...request.args, category: "rule", query: "" } }, config);
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
