import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import defaults from "./config.js";
import {
  cleanupExpired,
  listTrash,
  moveToTrash,
  purgeTrashItem,
  restoreFromTrash,
  trashStatus
} from "./trash-store.js";

const toolName = "trash";
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { getChatToolStateDir } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`trash

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions via args.action:
  status   Report retained trash size and filesystem capacity.
  move     Move one absolute args.path into recoverable chat-scoped trash.
  list     List trash metadata; optional args.status filters results.
  restore  Restore args.id to its original path or args.destination.
  purge    Permanently remove args.id; args.confirm must exactly match the id.
  cleanup  Permanently purge expired items; args.confirm must be PURGE_EXPIRED.

Safety behavior:
  - Same-filesystem moves use atomic rename and consume no duplicate disk space.
  - Cross-filesystem moves check projected usage and reserved free space before copying.
  - Cross-filesystem copies are verified before the source is removed.
  - Restore never overwrites an existing path.
  - Moving to trash does not reclaim space until explicit purge.
`);
}

function ok(value) {
  return { ok: true, output: { text: JSON.stringify({ ok: true, ...value }, null, 2), mimeType: "application/json" } };
}

function fail(error) {
  return { ok: false, error: error?.message || String(error) };
}

function requireChatId(request) {
  if (request.chatId == null || request.chatId === "") throw new Error("trash requires a chatId for isolated recoverable storage");
  return request.chatId;
}

function sourcePath(request) {
  const value = request.args?.path || request.text;
  if (!value) throw new Error("move requires one absolute args.path");
  return String(value).trim();
}

async function handle(request) {
  const chatId = requireChatId(request);
  const args = request.args || {};
  const action = args.action || "status";
  const config = await loadToolConfig(toolName, defaults, chatId);
  const stateRoot = getChatToolStateDir(chatId, toolName);

  if (action === "status") return trashStatus({ stateRoot, config });
  if (action === "list") return listTrash({ stateRoot, status: args.status || null });
  if (action === "move") return moveToTrash({ sourcePath: sourcePath(request), stateRoot, config });
  if (action === "restore") return restoreFromTrash({ id: args.id, destinationPath: args.destination, stateRoot, config });
  if (action === "purge") return purgeTrashItem({ id: args.id, confirmation: args.confirm, stateRoot });
  if (action === "cleanup") return cleanupExpired({ confirmation: args.confirm, stateRoot });
  throw new Error(`Unknown trash action: ${action}`);
}

async function main() {
  const [command, flag, requestFile] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") return printHelp();
  if (command !== "run" || flag !== "--request-file" || !requestFile) {
    console.log(JSON.stringify(fail("Usage: node index.js run --request-file <json>")));
    return;
  }
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    console.log(JSON.stringify(ok(await handle(request))));
  } catch (error) {
    console.log(JSON.stringify(fail(error)));
  }
}

main();
