import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

const NEVER_TRASH = ["/", "/dev", "/proc", "/run", "/sys"];
const VALID_ID = /^[0-9]{8}T[0-9]{6}-[a-f0-9-]{36}$/;

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isAtOrBelow(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function normalizeAbsolute(value, field = "path") {
  if (!value || !path.isAbsolute(String(value))) throw new Error(`${field} must be an absolute path`);
  return path.resolve(String(value));
}

function validateId(id) {
  const value = String(id || "");
  if (!VALID_ID.test(value)) throw new Error("A valid trash item id is required");
  return value;
}

function itemPaths(stateRoot, id) {
  const itemRoot = path.join(stateRoot, "items", validateId(id));
  return { itemRoot, payload: path.join(itemRoot, "payload"), metadata: path.join(itemRoot, "metadata.json") };
}

async function pathInfo(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function measurePath(target, seen = new Set()) {
  const stats = await lstat(target);
  const inode = `${stats.dev}:${stats.ino}`;
  if (seen.has(inode)) return 0;
  seen.add(inode);
  if (!stats.isDirectory()) return stats.size;
  const entries = await readdir(target);
  let bytes = 0;
  for (const entry of entries) bytes += await measurePath(path.join(target, entry), seen);
  return bytes;
}

async function filesystemSpace(target) {
  const stats = await statfs(target);
  const blockSize = Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * blockSize;
  const availableBytes = Number(stats.bavail) * blockSize;
  const usedBytes = totalBytes - Number(stats.bfree) * blockSize;
  return {
    totalBytes,
    usedBytes,
    availableBytes,
    usagePercent: totalBytes ? Number(((usedBytes / totalBytes) * 100).toFixed(2)) : 0
  };
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function assertSafeSource(source, stateRoot, config) {
  if (NEVER_TRASH.some((protectedPath) => isAtOrBelow(source, protectedPath))) {
    throw new Error(`Refusing to trash protected system path: ${source}`);
  }
  for (const configured of config.protectedPaths || []) {
    const protectedPath = normalizeAbsolute(configured, "protectedPaths entry");
    if (isAtOrBelow(source, protectedPath)) throw new Error(`Refusing to trash configured protected path: ${source}`);
  }
  if (isAtOrBelow(source, stateRoot) || isAtOrBelow(stateRoot, source)) {
    throw new Error("Refusing to trash the trash store or one of its parent directories");
  }
}

function projectedUsage(space, addedBytes) {
  return space.totalBytes ? ((space.usedBytes + addedBytes) / space.totalBytes) * 100 : 100;
}

function assertCopyFits(space, bytes, config) {
  const reserve = Math.max(0, asNumber(config.minimumFreeBytes, 0));
  const maxUsage = Math.min(100, Math.max(1, asNumber(config.maxFilesystemUsagePercent, 90)));
  if (space.availableBytes - bytes < reserve) {
    throw new Error(`Cross-filesystem copy refused: it would leave less than ${reserve} free bytes`);
  }
  if (projectedUsage(space, bytes) > maxUsage) {
    throw new Error(`Cross-filesystem copy refused: projected filesystem usage exceeds ${maxUsage}%`);
  }
}

async function guardedMove(source, destination, bytes, config) {
  const [sourceStats, destinationStats] = await Promise.all([lstat(source), lstat(path.dirname(destination))]);
  if (sourceStats.dev === destinationStats.dev) {
    await rename(source, destination);
    return "rename";
  }
  if (!config.allowCrossFilesystemCopy) throw new Error("Cross-filesystem trash moves are disabled");
  const space = await filesystemSpace(path.dirname(destination));
  assertCopyFits(space, bytes, config);
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true
  });
  const copiedBytes = await measurePath(destination);
  if (copiedBytes !== bytes) {
    await rm(destination, { recursive: true, force: true });
    throw new Error(`Cross-filesystem copy verification failed: expected ${bytes} bytes, copied ${copiedBytes}`);
  }
  await rm(source, { recursive: true, force: false });
  return "copy-verify-remove";
}

function lowSpaceWarnings(space, bytes, config, sameFilesystem) {
  const warnings = [];
  const reserve = Math.max(0, asNumber(config.minimumFreeBytes, 0));
  const maxUsage = asNumber(config.maxFilesystemUsagePercent, 90);
  if (space.availableBytes < reserve || space.usagePercent >= maxUsage) {
    warnings.push("The trash filesystem is low on space.");
  }
  if (sameFilesystem && bytes > 0) {
    warnings.push("This same-filesystem trash move is recoverable but does not reclaim disk space; explicit purge is required to free it.");
  }
  return warnings;
}

async function existingAncestor(target) {
  let current = path.resolve(target);
  while (!(await pathInfo(current))) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing parent filesystem found for ${target}`);
    current = parent;
  }
  return current;
}

async function listMetadata(stateRoot) {
  const itemsRoot = path.join(stateRoot, "items");
  const entries = await readdir(itemsRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !VALID_ID.test(entry.name)) continue;
    const metadata = await readJson(path.join(itemsRoot, entry.name, "metadata.json")).catch(() => null);
    if (metadata) items.push(metadata);
  }
  return items.sort((a, b) => String(b.trashedAt || "").localeCompare(String(a.trashedAt || "")));
}

export async function moveToTrash({ sourcePath, stateRoot, config, now = new Date() }) {
  const source = normalizeAbsolute(sourcePath);
  const root = path.resolve(stateRoot);
  assertSafeSource(source, root, config);
  const sourceStats = await pathInfo(source);
  if (!sourceStats) throw new Error(`Path does not exist: ${source}`);

  await mkdir(path.join(root, "items"), { recursive: true });
  const id = `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "")}-${randomUUID()}`;
  const paths = itemPaths(root, id);
  await mkdir(paths.itemRoot, { recursive: false });
  const bytes = await measurePath(source);
  const rootStats = await lstat(root);
  const sameFilesystem = sourceStats.dev === rootStats.dev;
  const spaceBefore = await filesystemSpace(root);
  const retentionDays = Math.max(1, asNumber(config.retentionDays, 30));
  const metadata = {
    id,
    status: "pending",
    originalPath: source,
    bytes,
    kind: sourceStats.isDirectory() ? "directory" : sourceStats.isSymbolicLink() ? "symlink" : "file",
    trashedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + retentionDays * 86400000).toISOString()
  };
  await writeJsonAtomic(paths.metadata, metadata);
  try {
    const storageMethod = await guardedMove(source, paths.payload, bytes, config);
    const complete = { ...metadata, status: "trashed", storageMethod };
    await writeJsonAtomic(paths.metadata, complete);
    return {
      action: "move",
      ...complete,
      space: spaceBefore,
      warnings: lowSpaceWarnings(spaceBefore, bytes, config, sameFilesystem)
    };
  } catch (error) {
    await writeJsonAtomic(paths.metadata, {
      ...metadata,
      status: "failed",
      error: error?.message || String(error)
    }).catch(() => {});
    throw error;
  }
}

export async function restoreFromTrash({ id, destinationPath, stateRoot, config, now = new Date() }) {
  const paths = itemPaths(path.resolve(stateRoot), id);
  const metadata = await readJson(paths.metadata);
  if (metadata.status !== "trashed") throw new Error(`Trash item ${id} is not restorable; status is ${metadata.status}`);
  const destination = normalizeAbsolute(destinationPath || metadata.originalPath, "destination");
  if (await pathInfo(destination)) throw new Error(`Restore destination already exists: ${destination}`);
  const ancestor = await existingAncestor(path.dirname(destination));
  const [payloadStats, ancestorStats] = await Promise.all([lstat(paths.payload), lstat(ancestor)]);
  if (payloadStats.dev !== ancestorStats.dev) assertCopyFits(await filesystemSpace(ancestor), metadata.bytes, config);
  await mkdir(path.dirname(destination), { recursive: true });
  const storageMethod = await guardedMove(paths.payload, destination, metadata.bytes, config);
  const complete = {
    ...metadata,
    status: "restored",
    restoredAt: now.toISOString(),
    restoredPath: destination,
    restoreMethod: storageMethod
  };
  await writeJsonAtomic(paths.metadata, complete);
  return { action: "restore", ...complete };
}

export async function purgeTrashItem({ id, confirmation, stateRoot, now = new Date() }) {
  const paths = itemPaths(path.resolve(stateRoot), id);
  const metadata = await readJson(paths.metadata);
  if (metadata.status !== "trashed") throw new Error(`Trash item ${id} cannot be purged; status is ${metadata.status}`);
  if (String(confirmation || "") !== id) throw new Error("Permanent purge requires args.confirm to exactly match the trash item id");
  await rm(paths.payload, { recursive: true, force: false });
  const complete = { ...metadata, status: "purged", purgedAt: now.toISOString() };
  await writeJsonAtomic(paths.metadata, complete);
  return { action: "purge", ...complete, reclaimedBytes: metadata.bytes };
}

export async function cleanupExpired({ confirmation, stateRoot, now = new Date() }) {
  if (confirmation !== "PURGE_EXPIRED") throw new Error("Expired cleanup requires args.confirm to equal PURGE_EXPIRED");
  const items = await listMetadata(path.resolve(stateRoot));
  const purged = [];
  for (const item of items) {
    if (item.status !== "trashed" || Date.parse(item.expiresAt) > now.getTime()) continue;
    purged.push(await purgeTrashItem({ id: item.id, confirmation: item.id, stateRoot, now }));
  }
  return {
    action: "cleanup",
    purged: purged.map(({ id, originalPath, reclaimedBytes }) => ({ id, originalPath, reclaimedBytes })),
    reclaimedBytes: purged.reduce((total, item) => total + item.reclaimedBytes, 0)
  };
}

export async function listTrash({ stateRoot, status = null }) {
  const items = await listMetadata(path.resolve(stateRoot));
  return {
    action: "list",
    items: status ? items.filter((item) => item.status === status) : items
  };
}

export async function trashStatus({ stateRoot, config }) {
  const root = path.resolve(stateRoot);
  await mkdir(root, { recursive: true });
  const items = await listMetadata(root);
  const trashed = items.filter((item) => item.status === "trashed");
  const space = await filesystemSpace(root);
  const retainedBytes = trashed.reduce((total, item) => total + Number(item.bytes || 0), 0);
  return {
    action: "status",
    counts: Object.fromEntries(["trashed", "restored", "purged", "failed", "pending"].map((status) => [status, items.filter((item) => item.status === status).length])),
    retainedBytes,
    space,
    retentionDays: config.retentionDays,
    minimumFreeBytes: config.minimumFreeBytes,
    maxFilesystemUsagePercent: config.maxFilesystemUsagePercent,
    warnings: lowSpaceWarnings(space, 0, config, true)
  };
}
