import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, readlink, rm, statfs, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

function posix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isProtected(relativePath, protectedFiles) {
  return protectedFiles.some((entry) => {
    const normalized = String(entry).replace(/^\.\//, "").replace(/\\/g, "/");
    return relativePath === normalized || relativePath.startsWith(`${normalized}/`);
  });
}

export async function scanTree(root, { protectedFiles = [] } = {}) {
  const files = {};
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const relative = posix(path.join(relativeDirectory, entry.name));
      if (isProtected(relative, protectedFiles)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(absolute);
        files[relative] = { type: "symlink", hash: hash(target), target };
      } else if (entry.isFile()) {
        const [content, stats] = await Promise.all([readFile(absolute), lstat(absolute)]);
        files[relative] = { type: "file", hash: hash(content), mode: stats.mode & 0o777 };
      }
    }
  }
  await visit(root);
  return files;
}

function valueHash(record) {
  return record ? `${record.type}:${record.hash}:${record.mode || ""}` : null;
}

export function changedPaths(before = {}, after = {}) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((item) => valueHash(before[item]) !== valueHash(after[item])).sort();
}

export function classifyTool({ localFiles, officialFiles, baselineFiles = null, baselineCommit = null, remoteCommit }) {
  const exact = changedPaths(localFiles, officialFiles).length === 0;
  if (exact) {
    return {
      status: baselineCommit === remoteCommit ? "up-to-date" : "baseline-refresh",
      safeToUpdate: true,
      localChanges: [],
      upstreamChanges: baselineFiles ? changedPaths(baselineFiles, officialFiles) : [] ,
      conflicts: []
    };
  }
  if (!baselineFiles) {
    const incompatibleOfficialPaths = Object.keys(officialFiles).filter((item) => valueHash(localFiles[item]) !== valueHash(officialFiles[item]));
    const localOnlyPaths = Object.keys(localFiles).filter((item) => !officialFiles[item]).sort();
    if (!incompatibleOfficialPaths.length) {
      return {
        status: "baseline-refresh",
        safeToUpdate: true,
        localChanges: localOnlyPaths,
        upstreamChanges: [],
        conflicts: []
      };
    }
    return {
      status: "untracked-difference",
      safeToUpdate: false,
      localChanges: changedPaths(officialFiles, localFiles),
      upstreamChanges: [],
      conflicts: incompatibleOfficialPaths.sort()
    };
  }
  const localChanges = changedPaths(baselineFiles, localFiles);
  const upstreamChanges = changedPaths(baselineFiles, officialFiles);
  const conflicts = localChanges.filter((item) => upstreamChanges.includes(item) && valueHash(localFiles[item]) !== valueHash(officialFiles[item]));
  let status;
  if (!upstreamChanges.length) status = "locally-modified";
  else if (conflicts.length) status = "conflict";
  else status = "update-available";
  return { status, safeToUpdate: status === "update-available", localChanges, upstreamChanges, conflicts };
}

export function updatePlan({ localFiles, officialFiles, baselineFiles = null, forceOfficial = false }) {
  const apply = [];
  const remove = [];
  const preserve = [];
  const conflicts = [];
  const paths = new Set([
    ...Object.keys(localFiles),
    ...Object.keys(officialFiles),
    ...Object.keys(baselineFiles || {})
  ]);
  for (const relativePath of [...paths].sort()) {
    const local = localFiles[relativePath];
    const official = officialFiles[relativePath];
    const baseline = baselineFiles?.[relativePath];
    if (!baselineFiles) {
      if (official && (!local || valueHash(local) !== valueHash(official))) apply.push(relativePath);
      else if (local && !official) preserve.push(relativePath);
      continue;
    }
    const localChanged = valueHash(local) !== valueHash(baseline);
    const upstreamChanged = valueHash(official) !== valueHash(baseline);
    if (localChanged && upstreamChanged && valueHash(local) !== valueHash(official)) {
      conflicts.push(relativePath);
      if (forceOfficial) official ? apply.push(relativePath) : remove.push(relativePath);
      continue;
    }
    if (upstreamChanged) official ? apply.push(relativePath) : remove.push(relativePath);
    else if (localChanged) preserve.push(relativePath);
  }
  return { apply, remove, preserve, conflicts };
}

export async function applyPlan({ stageDir, officialDir, plan }) {
  for (const relativePath of plan.remove) {
    await rm(path.join(stageDir, relativePath), { recursive: true, force: true });
  }
  for (const relativePath of plan.apply) {
    const source = path.join(officialDir, relativePath);
    const destination = path.join(stageDir, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    const stats = await lstat(source);
    if (stats.isSymbolicLink()) await symlink(await readlink(source), destination);
    else await cp(source, destination, { preserveTimestamps: true });
    if (stats.isFile()) {
      const mode = stats.mode & 0o777;
      const { chmod } = await import("node:fs/promises");
      await chmod(destination, mode);
    }
  }
}

export async function copyLocalToStage(localDir, stageDir) {
  await cp(localDir, stageDir, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const relative = path.relative(localDir, source);
      return !relative.split(path.sep).some((part) => part === "node_modules");
    }
  });
}

export async function measureTree(root) {
  let total = 0;
  const seen = new Set();
  async function visit(target) {
    const stats = await lstat(target);
    const inode = `${stats.dev}:${stats.ino}`;
    if (seen.has(inode)) return;
    seen.add(inode);
    if (!stats.isDirectory()) {
      total += stats.size;
      return;
    }
    for (const entry of await readdir(target)) await visit(path.join(target, entry));
  }
  await visit(root);
  return total;
}

export async function diskSpace(target) {
  const stats = await statfs(target);
  const blockSize = Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * blockSize;
  const availableBytes = Number(stats.bavail) * blockSize;
  const usedBytes = totalBytes - Number(stats.bfree) * blockSize;
  return { totalBytes, availableBytes, usedBytes, usagePercent: totalBytes ? Number(((usedBytes / totalBytes) * 100).toFixed(2)) : 0 };
}

export function assertStagingFits(space, requiredBytes, config) {
  const reserve = Number(config.minimumFreeBytes || 0);
  const maximum = Number(config.maxFilesystemUsagePercent || 90);
  if (space.availableBytes - requiredBytes < reserve) throw new Error(`Update staging refused: it would leave less than ${reserve} free bytes`);
  const projected = space.totalBytes ? ((space.usedBytes + requiredBytes) / space.totalBytes) * 100 : 100;
  if (projected > maximum) throw new Error(`Update staging refused: projected filesystem usage would exceed ${maximum}%`);
}

export async function writeBaseline(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readBaseline(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
