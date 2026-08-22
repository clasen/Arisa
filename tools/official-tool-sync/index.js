import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import defaults from "./config.js";
import { installStagedDependencies } from "./dependency-installer.js";
import {
  applyPlan,
  assertStagingFits,
  changedPaths,
  classifyTool,
  copyLocalToStage,
  diskSpace,
  measureTree,
  readBaseline,
  scanTree,
  updatePlan,
  writeBaseline
} from "./sync-lib.js";

const toolName = "official-tool-sync";
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "../../package");
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { createArisaClient } = await importCore("core/tools/ipc-client.js");
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { getChatToolTmpDir, getToolDir, getToolStateDir } = await importCore("runtime/paths.js");

function printHelp() {
  console.log(`official-tool-sync

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions via args.action:
  check        Fetch the official catalog, compare installed official tools, and adopt exact matches as baselines.
  diff         Show file-level differences for args.name.
  update       Safely update args.name when it has a trusted baseline and no conflicts.
  update-safe  Update every installed official tool classified as safely updateable.

Safety behavior:
  - config.js and configured protected files are never compared or overwritten.
  - Local-only files and non-conflicting local changes are preserved.
  - Conflicting or untracked differences are refused by default.
  - To explicitly replace divergent official-managed files, args.confirmDiverged must exactly equal args.name.
  - Dependencies are installed inside an isolated staging package and verified before CLI validation.
  - The current tool directory is moved through the essential trash tool before atomic replacement.
  - Every successful update returns a trash backup id for undo.
`);
}

function ok(value) {
  return { ok: true, output: { text: JSON.stringify({ ok: true, ...value }, null, 2), mimeType: "application/json" } };
}

function fail(error) {
  return { ok: false, error: error?.message || String(error) };
}

function validName(value) {
  const name = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("args.name must be a valid tool name");
  return name;
}

function parsePositive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function exists(target) {
  return access(target).then(() => true, () => false);
}

async function runCommand(command, args, { cwd, timeoutMs, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs || 180000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal || code}): ${(stderr || stdout).trim().slice(-2000)}`));
    });
  });
}

async function cloneCatalog({ scratchRoot, config }) {
  const repoDir = path.join(scratchRoot, "repo");
  await runCommand("git", ["clone", "--depth", "1", "--branch", config.branch, "--", config.repoUrl, repoDir], {
    cwd: scratchRoot,
    timeoutMs: parsePositive(config.commandTimeoutMs, 180000)
  });
  const { stdout } = await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoDir, timeoutMs: 30000 });
  return { repoDir, remoteCommit: stdout.trim() };
}

async function officialToolNames(repoDir) {
  const root = path.join(repoDir, "tools");
  const entries = await readdir(root, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (entry.isDirectory() && await exists(path.join(root, entry.name, "tool.manifest.json"))) names.push(entry.name);
  }
  return names.sort();
}

function baselineFile(name) {
  return path.join(getToolStateDir(toolName), "baselines", `${name}.json`);
}

function protectedFiles(config) {
  return [...new Set(["config.js", ...(config.protectedFiles || [])])];
}

async function inspectOne({ name, repoDir, remoteCommit, config }) {
  const localDir = getToolDir(name);
  const officialDir = path.join(repoDir, "tools", name);
  if (!(await exists(officialDir))) throw new Error(`${name} is not present in the official catalog`);
  if (!(await exists(localDir))) return { name, status: "not-installed", installed: false };
  const options = { protectedFiles: protectedFiles(config) };
  const [localFiles, officialFiles, baseline] = await Promise.all([
    scanTree(localDir, options),
    scanTree(officialDir, options),
    readBaseline(baselineFile(name))
  ]);
  const classification = classifyTool({
    localFiles,
    officialFiles,
    baselineFiles: baseline?.files || null,
    baselineCommit: baseline?.commit || null,
    remoteCommit
  });
  return {
    name,
    installed: true,
    localDir,
    officialDir,
    remoteCommit,
    baseline,
    localFiles,
    officialFiles,
    ...classification
  };
}

function publicInspection(item) {
  return {
    name: item.name,
    installed: item.installed,
    status: item.status,
    safeToUpdate: Boolean(item.safeToUpdate),
    baselineCommit: item.baseline?.commit || null,
    remoteCommit: item.remoteCommit || null,
    localChanges: item.localChanges || [],
    upstreamChanges: item.upstreamChanges || [],
    conflicts: item.conflicts || []
  };
}

async function adoptExactBaseline(item, repoUrl) {
  if (!item.installed || !["up-to-date", "baseline-refresh"].includes(item.status)) return false;
  await writeBaseline(baselineFile(item.name), {
    tool: item.name,
    repo: repoUrl,
    commit: item.remoteCommit,
    recordedAt: new Date().toISOString(),
    files: item.officialFiles
  });
  return true;
}

async function inspectInstalledCatalog(context) {
  const names = await officialToolNames(context.repoDir);
  const items = [];
  for (const name of names) {
    const item = await inspectOne({ name, ...context });
    if (item.installed) items.push(item);
  }
  return { officialCount: names.length, items };
}

async function installDependencies(stageDir, config) {
  return installStagedDependencies(stageDir, {
    runCommand,
    timeoutMs: parsePositive(config.commandTimeoutMs, 180000)
  });
}

async function validateStage(stageDir, expectedName, config) {
  const manifestFile = path.join(stageDir, "tool.manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (manifest.name !== expectedName) throw new Error(`Staged manifest name mismatch: expected ${expectedName}, got ${manifest.name}`);
  const entry = manifest.entry || "index.js";
  if (!(await exists(path.join(stageDir, entry)))) throw new Error(`Staged entry does not exist: ${entry}`);
  const timeoutMs = parsePositive(config.commandTimeoutMs, 180000);
  await runCommand(process.execPath, ["--check", entry], { cwd: stageDir, timeoutMs });
  await runCommand(process.execPath, [entry, "--help"], {
    cwd: stageDir,
    timeoutMs,
    env: { ...process.env, ARISA_PACKAGE_DIR: arisaPackageDir }
  });
  return { manifest: manifest.name, entry, syntax: "ok", help: "ok" };
}

function parseToolText(output) {
  if (output?.json) return output.json;
  if (typeof output?.text === "string") return JSON.parse(output.text);
  throw new Error("Tool returned no parseable JSON output");
}

async function runArisaTool(arisa, name, args, timeoutMs) {
  const result = await arisa.tools.run({ name, args }, { timeoutMs });
  if (!result?.ok) throw new Error(`${name} failed: ${result?.error || result?.status || "unknown error"}`);
  return parseToolText(result.output);
}

async function deployWithTrash({ arisa, name, localDir, stageDir, timeoutMs }) {
  const backup = await runArisaTool(arisa, "trash", { action: "move", path: localDir }, timeoutMs);
  try {
    await rename(stageDir, localDir);
    return { backupTrashId: backup.id, backupExpiresAt: backup.expiresAt };
  } catch (error) {
    await runArisaTool(arisa, "trash", { action: "restore", id: backup.id }, timeoutMs).catch(() => {});
    throw error;
  }
}

async function updateOne({ item, config, scratchRoot, arisa, forceOfficial = false }) {
  if (["up-to-date", "baseline-refresh"].includes(item.status)) {
    await adoptExactBaseline(item, config.repoUrl);
    return { name: item.name, action: "no-op", status: "up-to-date" };
  }
  if (!item.safeToUpdate && !forceOfficial) {
    throw new Error(`${item.name} is ${item.status}; refusing update without args.confirmDiverged exactly equal to ${item.name}`);
  }
  const plan = updatePlan({
    localFiles: item.localFiles,
    officialFiles: item.officialFiles,
    baselineFiles: item.baseline?.files || null,
    forceOfficial
  });
  if (plan.conflicts.length && !forceOfficial) throw new Error(`${item.name} has conflicts: ${plan.conflicts.join(", ")}`);

  const localBytes = await measureTree(item.localDir);
  const requiredBytes = localBytes + parsePositive(config.stagingHeadroomBytes, 536870912);
  assertStagingFits(await diskSpace(scratchRoot), requiredBytes, config);
  const stageDir = path.join(scratchRoot, `stage-${item.name}`);
  await rm(stageDir, { recursive: true, force: true });
  await copyLocalToStage(item.localDir, stageDir);
  await applyPlan({ stageDir, officialDir: item.officialDir, plan });
  const dependencies = await installDependencies(stageDir, config);
  const validation = await validateStage(stageDir, item.name, config);
  const timeoutMs = parsePositive(config.commandTimeoutMs, 180000);
  const deployment = await deployWithTrash({ arisa, name: item.name, localDir: item.localDir, stageDir, timeoutMs });
  await writeBaseline(baselineFile(item.name), {
    tool: item.name,
    repo: config.repoUrl,
    commit: item.remoteCommit,
    recordedAt: new Date().toISOString(),
    files: item.officialFiles
  });
  return {
    name: item.name,
    action: "updated",
    forced: forceOfficial,
    applied: plan.apply,
    removed: plan.remove,
    preserved: plan.preserve,
    conflictsOverridden: forceOfficial ? plan.conflicts : [],
    dependencies,
    validation,
    ...deployment,
    warning: "The recoverable trash backup retains disk space until explicitly purged."
  };
}

async function withCatalog(request, work) {
  if (request.chatId == null) throw new Error("official-tool-sync requires chatId");
  const config = await loadToolConfig(toolName, defaults, request.chatId);
  const scratchRoot = getChatToolTmpDir(request.chatId, toolName);
  await rm(scratchRoot, { recursive: true, force: true });
  await mkdir(scratchRoot, { recursive: true });
  assertStagingFits(await diskSpace(scratchRoot), parsePositive(config.stagingHeadroomBytes, 536870912), config);
  try {
    const catalog = await cloneCatalog({ scratchRoot, config });
    return await work({ ...catalog, config, scratchRoot });
  } finally {
    await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function handle(request) {
  const args = request.args || {};
  const action = args.action || "check";
  return withCatalog(request, async (context) => {
    if (action === "check") {
      const inventory = await inspectInstalledCatalog(context);
      let adopted = 0;
      for (const item of inventory.items) if (await adoptExactBaseline(item, context.config.repoUrl)) adopted += 1;
      return {
        action,
        remoteCommit: context.remoteCommit,
        officialCount: inventory.officialCount,
        installedOfficialCount: inventory.items.length,
        baselinesRecorded: adopted,
        tools: inventory.items.map(publicInspection)
      };
    }
    if (action === "diff") {
      const item = await inspectOne({ name: validName(args.name), ...context });
      return {
        action,
        ...publicInspection(item),
        officialVsLocal: changedPaths(item.officialFiles || {}, item.localFiles || {})
      };
    }
    if (action === "update") {
      const name = validName(args.name);
      const item = await inspectOne({ name, ...context });
      if (!item.installed) throw new Error(`${name} is not installed`);
      const arisa = createArisaClient({ toolName, chatId: request.chatId });
      return updateOne({
        item,
        ...context,
        arisa,
        forceOfficial: String(args.confirmDiverged || "") === name
      });
    }
    if (action === "update-safe") {
      const inventory = await inspectInstalledCatalog(context);
      const arisa = createArisaClient({ toolName, chatId: request.chatId });
      const updates = [];
      for (const item of inventory.items) {
        if (["up-to-date", "baseline-refresh"].includes(item.status)) {
          await adoptExactBaseline(item, context.config.repoUrl);
          continue;
        }
        if (!item.safeToUpdate) continue;
        updates.push(await updateOne({ item, ...context, arisa }));
      }
      return {
        action,
        remoteCommit: context.remoteCommit,
        updates,
        skipped: inventory.items.filter((item) => !item.safeToUpdate && !["up-to-date", "baseline-refresh"].includes(item.status)).map(publicInspection)
      };
    }
    throw new Error(`Unknown official-tool-sync action: ${action}`);
  });
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
