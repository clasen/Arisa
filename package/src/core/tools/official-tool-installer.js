import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getToolDir } from "../../runtime/paths.js";

const bundledLockFile = new URL("../../official-tools.lock.json", import.meta.url);

const TOOL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function exists(target) {
  return access(target).then(() => true, () => false);
}

function assertRelativeFilePath(file) {
  if (typeof file !== "string" || !file || file.includes("\\")) {
    throw new Error(`Invalid official tool file path: ${file || "empty"}`);
  }
  const normalized = path.posix.normalize(file);
  if (normalized !== file || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid official tool file path: ${file}`);
  }
}

export function validateOfficialToolLock(lock, toolName) {
  if (!TOOL_NAME_PATTERN.test(String(toolName || ""))) {
    throw new Error(`Invalid official tool name: ${toolName || "empty"}`);
  }
  if (lock?.version !== 1) throw new Error("Unsupported official tool lock version");
  if (typeof lock.repository !== "string" || !lock.repository.startsWith("https://")) {
    throw new Error("Official tool lock requires an HTTPS repository");
  }
  if (!COMMIT_PATTERN.test(String(lock.commit || ""))) {
    throw new Error("Official tool lock requires an immutable 40-character commit");
  }
  const files = lock.tools?.[toolName]?.files;
  if (!files || typeof files !== "object" || Array.isArray(files) || !Object.keys(files).length) {
    throw new Error(`Official tool lock has no files for ${toolName}`);
  }
  for (const [file, digest] of Object.entries(files)) {
    assertRelativeFilePath(file);
    if (!SHA256_PATTERN.test(String(digest || ""))) {
      throw new Error(`Invalid SHA-256 digest for ${toolName}/${file}`);
    }
  }
  return { repository: lock.repository, commit: lock.commit, files };
}

async function walkFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childPath = path.join(root, ...childRelative.split("/"));
    const metadata = await lstat(childPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Official tool contains a symbolic link: ${childRelative}`);
    }
    if (metadata.isDirectory()) {
      files.push(...await walkFiles(root, childRelative));
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`Official tool contains an unsupported entry: ${childRelative}`);
    }
    files.push(childRelative);
  }
  return files;
}

async function sha256(file) {
  return crypto.createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function verifyOfficialToolTree(toolDir, expectedFiles) {
  const actualFiles = (await walkFiles(toolDir)).sort();
  const lockedFiles = Object.keys(expectedFiles).sort();
  if (actualFiles.length !== lockedFiles.length || actualFiles.some((file, index) => file !== lockedFiles[index])) {
    const missing = lockedFiles.filter((file) => !actualFiles.includes(file));
    const unexpected = actualFiles.filter((file) => !lockedFiles.includes(file));
    throw new Error(`Official tool file set mismatch; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`);
  }
  for (const file of lockedFiles) {
    const digest = await sha256(path.join(toolDir, ...file.split("/")));
    if (!crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(expectedFiles[file], "hex"))) {
      throw new Error(`Official tool integrity check failed: ${file}`);
    }
  }
  return { files: lockedFiles.length };
}

function runCommand(command, args, { cwd, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} failed (${signal || code}): ${(stderr || stdout).trim().slice(-2000)}`));
    });
  });
}

async function checkoutRepository({ repository, commit, checkoutDir }) {
  await mkdir(checkoutDir, { recursive: true });
  await runCommand("git", ["init", "--quiet"], { cwd: checkoutDir });
  await runCommand("git", ["remote", "add", "origin", repository], { cwd: checkoutDir });
  await runCommand("git", ["fetch", "--quiet", "--depth", "1", "origin", commit], { cwd: checkoutDir });
  await runCommand("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: checkoutDir });
  const resolved = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: checkoutDir })).stdout.trim();
  if (resolved !== commit) throw new Error(`Official tool checkout resolved ${resolved}, expected ${commit}`);
}

async function validateEntrypoint(toolDir, toolName) {
  const manifest = JSON.parse(await readFile(path.join(toolDir, "tool.manifest.json"), "utf8"));
  if (manifest.name !== toolName) {
    throw new Error(`Official tool manifest mismatch: expected ${toolName}, got ${manifest.name || "missing"}`);
  }
  const entry = manifest.entry || "index.js";
  const entryPath = path.join(toolDir, entry);
  if (!(await exists(entryPath))) throw new Error(`Official tool entry does not exist: ${entry}`);
  await runCommand(process.execPath, ["--check", entry], { cwd: toolDir, timeoutMs: 30_000 });
  await runCommand(process.execPath, [entry, "--help"], { cwd: toolDir, timeoutMs: 30_000 });
}

export async function installLockedOfficialTool({
  toolName,
  lock,
  destination,
  scratchRoot = os.tmpdir(),
  checkout = checkoutRepository,
  validate = validateEntrypoint
}) {
  const locked = validateOfficialToolLock(lock, toolName);
  if (await exists(destination)) {
    throw new Error(`Refusing to overwrite installed tool: ${destination}`);
  }
  const scratch = await mkdtemp(path.join(scratchRoot, `arisa-${toolName}-`));
  const checkoutDir = path.join(scratch, "repository");
  const stageDir = path.join(scratch, "stage");
  try {
    await checkout({ repository: locked.repository, commit: locked.commit, checkoutDir });
    const sourceDir = path.join(checkoutDir, "tools", toolName);
    await verifyOfficialToolTree(sourceDir, locked.files);
    await cp(sourceDir, stageDir, { recursive: true, errorOnExist: true, force: false });
    await validate(stageDir, toolName);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(stageDir, destination);
    return { toolName, destination, commit: locked.commit, files: Object.keys(locked.files).length };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export async function installBundledOfficialTool(toolName, {
  lockFile = bundledLockFile,
  install = installLockedOfficialTool
} = {}) {
  const lock = JSON.parse(await readFile(lockFile, "utf8"));
  return install({ toolName, lock, destination: getToolDir(toolName) });
}
