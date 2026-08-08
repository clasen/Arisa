import path from "node:path";
import { fileURLToPath } from "node:url";
import { readUtf8Json } from "./lib.js";
import { queueNotification } from "./worker.js";

const thisFile = fileURLToPath(import.meta.url);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function retryPendingNotification(statusFile, {
  retryIntervalMs = 10000,
  retryTimeoutMs = 24 * 60 * 60 * 1000
} = {}) {
  const deadline = Date.now() + retryTimeoutMs;
  while (Date.now() < deadline) {
    const status = await readUtf8Json(statusFile);
    if (!status || status.notificationQueued || !status.notificationPending) return status;
    const updated = await queueNotification(status, status);
    if (updated.notificationQueued) return updated;
    await sleep(retryIntervalMs);
  }
  return readUtf8Json(statusFile);
}

async function main() {
  const statusFile = process.argv[2];
  if (!statusFile) throw new Error("Notifier job file argument is required");
  await retryPendingNotification(statusFile);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)) {
  main().catch((error) => {
    console.error(`[arisa-restart-notifier] ${error.stack || error.message || String(error)}`);
    process.exitCode = 1;
  });
}
