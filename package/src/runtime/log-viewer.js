import { open, readFile, stat } from "node:fs/promises";
import { cliLogConfig } from "../core/config/config-defaults.js";
import { ensureArisaHome, serviceLogFile } from "../platform/paths.js";

const readChunkSize = 64 * 1024;

async function getFileState(logFile) {
  try {
    const details = await stat(logFile);
    return { size: details.size, ino: details.ino };
  } catch (error) {
    if (error?.code === "ENOENT") return { size: 0, ino: null };
    throw error;
  }
}

export async function readRecentLogLines(logFile, lineCount) {
  if (!Number.isSafeInteger(lineCount) || lineCount < 1) {
    throw new Error("Log line count must be a positive integer");
  }

  const state = await getFileState(logFile);
  if (state.size === 0) return { text: "", endsWithNewline: false, ...state };

  const handle = await open(logFile, "r");
  const chunks = [];
  let position = state.size;
  let newlineCount = 0;

  try {
    while (position > 0 && newlineCount <= lineCount) {
      const length = Math.min(readChunkSize, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      const content = chunk.subarray(0, bytesRead);
      chunks.unshift(content);
      for (const byte of content) {
        if (byte === 0x0a) newlineCount += 1;
      }
    }
  } finally {
    await handle.close();
  }

  const content = Buffer.concat(chunks).toString("utf8");
  const endsWithNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (endsWithNewline) lines.pop();
  return {
    text: lines.slice(-lineCount).join("\n"),
    endsWithNewline,
    ...state
  };
}

async function readAppendedBytes(logFile, position, size) {
  if (size <= position) return "";
  const handle = await open(logFile, "r");
  const chunks = [];
  let cursor = position;

  try {
    while (cursor < size) {
      const length = Math.min(readChunkSize, size - cursor);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, cursor);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      cursor += bytesRead;
    }
  } finally {
    await handle.close();
  }

  return Buffer.concat(chunks).toString("utf8");
}

function waitForNextPoll(intervalMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, intervalMs);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function followLogFile({
  logFile,
  initialSize,
  initialIno,
  write,
  signal,
  pollIntervalMs = cliLogConfig.followPollIntervalMs
}) {
  let position = initialSize;
  let ino = initialIno;

  while (!signal?.aborted) {
    await waitForNextPoll(pollIntervalMs, signal);
    if (signal?.aborted) break;

    const state = await getFileState(logFile);
    if (state.ino !== ino || state.size < position) {
      position = 0;
      ino = state.ino;
    }
    if (state.size === position) continue;

    try {
      const appended = await readAppendedBytes(logFile, position, state.size);
      if (appended) write(appended);
      position = state.size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      position = 0;
      ino = null;
    }
  }
}

export async function showServiceLogs({
  version,
  follow = true,
  output = process.stdout,
  signal
} = {}) {
  if (!version) throw new Error("Arisa version is required");
  await ensureArisaHome();

  const snapshot = await readRecentLogLines(serviceLogFile, cliLogConfig.recentLines);
  output.write(`Arisa v${version} | Recent logs\n`);
  output.write(`${follow ? "Following new logs; press Ctrl+C to exit." : "Log follow disabled."}\n\n`);
  if (snapshot.text) {
    output.write(snapshot.text);
    if (snapshot.endsWithNewline) output.write("\n");
  } else {
    output.write("No logs yet.\n");
  }

  if (!follow) return;
  await followLogFile({
    logFile: serviceLogFile,
    initialSize: snapshot.size,
    initialIno: snapshot.ino,
    write: (content) => output.write(content),
    signal
  });
}

export async function readPackageVersion() {
  const packageFile = new URL("../../package.json", import.meta.url);
  const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
  if (typeof packageJson.version !== "string" || !packageJson.version) {
    throw new Error("Arisa package version is missing");
  }
  return packageJson.version;
}
