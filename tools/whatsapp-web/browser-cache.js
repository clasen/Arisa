import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

const CACHE_PATHS = [
  ["Default", "Cache"],
  ["Default", "Code Cache"],
  ["Default", "GPUCache"],
  ["Default", "DawnGraphiteCache"],
  ["Default", "DawnWebGPUCache"],
  ["Default", "Service Worker", "CacheStorage"],
  ["GPUCache"],
  ["GPUPersistentCache"],
  ["GrShaderCache"],
  ["ShaderCache"],
  ["GraphiteDawnCache"]
];

async function directoryBytes(directory) {
  const info = await lstat(directory).catch(() => null);
  if (!info || info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    total += await directoryBytes(path.join(directory, entry.name));
  }
  return total;
}

export function cacheBudgetBytes(value, fallbackMb = 96) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const megabytes = Number.isFinite(parsed) ? Math.min(1024, Math.max(16, parsed)) : fallbackMb;
  return megabytes * 1024 * 1024;
}

export function chromiumCacheArgs(maxBytes) {
  const diskBytes = Math.max(8 * 1024 * 1024, Math.floor(maxBytes / 2));
  const mediaBytes = Math.max(4 * 1024 * 1024, Math.floor(maxBytes / 4));
  return [`--disk-cache-size=${diskBytes}`, `--media-cache-size=${mediaBytes}`];
}

export async function chromiumCacheUsage(profileDir) {
  const entries = [];
  for (const segments of CACHE_PATHS) {
    const directory = path.join(profileDir, ...segments);
    const bytes = await directoryBytes(directory);
    if (bytes > 0) entries.push({ directory, bytes });
  }
  return { bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), entries };
}

export async function pruneChromiumCaches(profileDir, maxBytes) {
  const usage = await chromiumCacheUsage(profileDir);
  if (usage.bytes <= maxBytes) return { beforeBytes: usage.bytes, afterBytes: usage.bytes, removedBytes: 0, removed: [] };

  let remaining = usage.bytes;
  const removed = [];
  for (const entry of [...usage.entries].sort((left, right) => right.bytes - left.bytes)) {
    if (remaining <= maxBytes) break;
    await rm(entry.directory, { recursive: true, force: true });
    remaining -= entry.bytes;
    removed.push(path.relative(profileDir, entry.directory));
  }
  return { beforeBytes: usage.bytes, afterBytes: Math.max(0, remaining), removedBytes: usage.bytes - Math.max(0, remaining), removed };
}
