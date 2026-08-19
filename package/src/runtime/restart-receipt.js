import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { arisaPackageDir, restartReceiptFile } from "./paths.js";

const execFileAsync = promisify(execFile);

function normalizeDestination({ transportChatId, threadId = null }) {
  const chatId = Number(transportChatId);
  if (!Number.isSafeInteger(chatId)) throw new Error("Restart receipt requires a valid Telegram chat id");
  const topic = threadId == null ? null : Number(threadId);
  if (topic != null && (!Number.isSafeInteger(topic) || topic <= 0)) {
    throw new Error("Restart receipt requires a valid Telegram topic id");
  }
  return { transportChatId: chatId, threadId: topic };
}

async function runtimeIdentity() {
  const packageJson = JSON.parse(await readFile(path.join(arisaPackageDir, "package.json"), "utf8"));
  let commit = null;
  try {
    const result = await execFileAsync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: arisaPackageDir });
    commit = String(result.stdout || "").trim() || null;
  } catch {}
  return { version: String(packageJson.version || "unknown"), commit };
}

export async function prepareRestartReceipt(destination, { reason = "requested restart" } = {}, {
  receiptFile = restartReceiptFile,
  getIdentity = runtimeIdentity
} = {}) {
  const target = normalizeDestination(destination);
  const identity = await getIdentity();
  const receipt = {
    id: crypto.randomUUID(),
    ...target,
    reason: String(reason || "requested restart").slice(0, 500),
    expectedVersion: identity.version,
    expectedCommit: identity.commit,
    requestedAt: new Date().toISOString()
  };
  await mkdir(path.dirname(receiptFile), { recursive: true, mode: 0o700 });
  const temporaryFile = `${receiptFile}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryFile, receiptFile);
  return receipt;
}

export async function cancelRestartReceipt(receiptId, { receiptFile = restartReceiptFile } = {}) {
  try {
    const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
    if (receipt.id !== receiptId) return false;
    await rm(receiptFile, { force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function deliverRestartReceipt(sendMessage, {
  receiptFile = restartReceiptFile,
  getIdentity = runtimeIdentity
} = {}) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  const actual = await getIdentity();
  const versionMatches = receipt.expectedVersion === actual.version;
  const commitMatches = !receipt.expectedCommit || receipt.expectedCommit === actual.commit;
  const genericReasons = new Set(["requested restart", "Agent-requested restart", "Telegram restart", "Telegram /restart", "Telegram update restart"]);
  const resultSummary = String(receipt.reason || "").trim();
  const lines = [
    versionMatches && commitMatches ? "Restart completed." : "Restart completed with an unexpected runtime identity.",
    resultSummary && !genericReasons.has(resultSummary) ? resultSummary : null,
    `Arisa ${actual.version} is running${actual.commit ? ` at commit ${actual.commit}` : ""}.`,
    versionMatches && commitMatches ? null : `Expected: ${receipt.expectedVersion}${receipt.expectedCommit ? ` at ${receipt.expectedCommit}` : ""}.`
  ].filter(Boolean);
  const options = receipt.threadId ? { message_thread_id: receipt.threadId } : {};
  await sendMessage(receipt.transportChatId, lines.join("\n"), options);
  await rm(receiptFile, { force: true });
  return { receipt, actual, verified: versionMatches && commitMatches };
}
