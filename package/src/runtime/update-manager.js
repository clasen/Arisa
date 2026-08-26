import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { arisaPackageDir, getToolDir } from "../platform/paths.js";
import { renderTextReport, reportRow, wrapReportText } from "./report-format.js";

const defaultRepoUrl = "https://github.com/clasen/Arisa.git";
const defaultBranch = "main";
const bootstrapToolNames = ["trash", "official-tool-sync"];

function exists(target) {
  return access(target).then(() => true, () => false);
}

function runCommand(command, args, { cwd, timeoutMs = 300_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal || code}): ${(stderr || stdout).trim().slice(-2000)}`));
    });
  });
}

function parseSemver(value) {
  const match = String(value || "").trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

async function readCurrentVersion() {
  const packageJson = JSON.parse(await readFile(path.join(arisaPackageDir, "package.json"), "utf8"));
  return packageJson.version;
}

async function fetchLatestVersion() {
  const { stdout } = await runCommand("npm", ["view", "arisa", "version", "--json"], { timeoutMs: 60_000 });
  const parsed = JSON.parse(stdout);
  const version = Array.isArray(parsed) ? parsed.at(-1) : parsed;
  if (!parseSemver(version)) throw new Error(`npm returned an invalid Arisa version: ${version}`);
  return version;
}

export async function installCoreUpdate({ targetVersion }, {
  readVersion = readCurrentVersion,
  fetchVersion = fetchLatestVersion,
  execute = runCommand
} = {}) {
  if (!parseSemver(targetVersion)) throw new Error("Invalid Arisa update version");
  const [currentVersion, latestVersion] = await Promise.all([readVersion(), fetchVersion()]);
  if (targetVersion !== latestVersion) {
    throw new Error(`Arisa ${latestVersion} is now the latest version. Run /update again.`);
  }
  if (compareVersions(currentVersion, latestVersion) !== -1) {
    return { updated: false, currentVersion, latestVersion };
  }

  await execute("npm", ["install", "--global", `arisa@${latestVersion}`]);
  const installedVersion = await readVersion();
  if (installedVersion !== latestVersion) {
    throw new Error(`npm completed, but Arisa is still ${installedVersion} instead of ${latestVersion}`);
  }
  return {
    updated: true,
    previousVersion: currentVersion,
    currentVersion: installedVersion
  };
}

async function cloneCatalog(scratchRoot) {
  const repoDir = path.join(scratchRoot, "repo");
  await runCommand("git", ["clone", "--depth", "1", "--branch", defaultBranch, "--", defaultRepoUrl, repoDir], { cwd: scratchRoot, timeoutMs: 180_000 });
  return repoDir;
}

async function installDependencies(toolDir) {
  if (!(await exists(path.join(toolDir, "package.json")))) return null;
  try {
    await runCommand("pnpm", ["install", "--lockfile=false"], { cwd: toolDir, timeoutMs: 300_000 });
    return "pnpm";
  } catch {
    await runCommand("npm", ["install", "--no-package-lock"], { cwd: toolDir, timeoutMs: 300_000 });
    return "npm";
  }
}

async function validateTool(toolDir, expectedName) {
  const manifest = JSON.parse(await readFile(path.join(toolDir, "tool.manifest.json"), "utf8"));
  if (manifest.name !== expectedName) throw new Error(`Bootstrap manifest mismatch for ${expectedName}`);
  const entry = manifest.entry || "index.js";
  const env = { ...process.env, ARISA_PACKAGE_DIR: arisaPackageDir };
  await runCommand(process.execPath, ["--check", entry], { cwd: toolDir, timeoutMs: 30_000, env });
  await runCommand(process.execPath, [entry, "--help"], { cwd: toolDir, timeoutMs: 30_000, env });
}

async function stageBootstrapTool(repoDir, scratchRoot, name) {
  const sourceDir = path.join(repoDir, "tools", name);
  const stageDir = path.join(scratchRoot, `stage-${name}`);
  if (!(await exists(path.join(sourceDir, "tool.manifest.json")))) throw new Error(`Official catalog is missing required bootstrap tool: ${name}`);
  await cp(sourceDir, stageDir, { recursive: true });
  await installDependencies(stageDir);
  await validateTool(stageDir, name);
  return { name, stageDir, destination: getToolDir(name) };
}

export async function ensureOfficialUpdateTools({ toolRegistry }) {
  const missing = bootstrapToolNames.filter((name) => !toolRegistry.get(name));
  if (!missing.length) return { installed: [] };
  const scratchRoot = path.join(os.tmpdir(), `arisa-update-${process.pid}-${Date.now()}`);
  await mkdir(scratchRoot, { recursive: true });
  const deployed = [];
  try {
    const repoDir = await cloneCatalog(scratchRoot);
    const staged = [];
    for (const name of missing) staged.push(await stageBootstrapTool(repoDir, scratchRoot, name));
    for (const item of staged) {
      await mkdir(path.dirname(item.destination), { recursive: true });
      await cp(item.stageDir, item.destination, { recursive: true, errorOnExist: true, force: false });
      deployed.push(item.destination);
    }
    await toolRegistry.load();
    return { installed: staged.map((item) => item.name) };
  } catch (error) {
    for (const destination of deployed.reverse()) await rm(destination, { recursive: true, force: true }).catch(() => {});
    await toolRegistry.load().catch(() => {});
    throw error;
  } finally {
    await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function parseToolSyncOutput(result) {
  if (!result?.ok) throw new Error(result?.error || "official-tool-sync failed");
  const text = result.output?.text;
  if (typeof text !== "string") return result.output?.json || {};
  return JSON.parse(text);
}

function summarizeTools(sync, installedTools) {
  const tools = sync.tools || [];
  const officialNames = new Set(tools.map((tool) => tool.name));
  const counts = {};
  for (const tool of tools) counts[tool.status] = (counts[tool.status] || 0) + 1;
  const updateable = tools.filter((tool) => tool.safeToUpdate && !["up-to-date", "baseline-refresh"].includes(tool.status));
  const blocked = tools.filter((tool) => !tool.safeToUpdate && !["up-to-date", "baseline-refresh"].includes(tool.status));
  return {
    installedOfficial: sync.installedOfficialCount || tools.length,
    official: tools.map(({ name, status }) => ({ name, status })).sort((left, right) => left.name.localeCompare(right.name)),
    nonOfficial: installedTools.map((tool) => tool.name).filter((name) => !officialNames.has(name)).sort(),
    counts,
    updateable: updateable.map((tool) => tool.name),
    blocked: blocked.map((tool) => ({ name: tool.name, status: tool.status }))
  };
}

export async function checkForUpdates({ chatId, toolRegistry }) {
  const [currentVersion, latestVersion] = await Promise.all([readCurrentVersion(), fetchLatestVersion()]);
  const bootstrapped = await ensureOfficialUpdateTools({ toolRegistry });
  const result = await toolRegistry.run({ name: "official-tool-sync", chatId, request: { args: { action: "check" } } });
  const sync = parseToolSyncOutput(result);
  return {
    core: { currentVersion, latestVersion, updateAvailable: compareVersions(currentVersion, latestVersion) === -1 },
    bootstrapInstalled: bootstrapped.installed,
    tools: summarizeTools(sync, toolRegistry.list())
  };
}

export async function updateOfficialTools({ chatId, toolRegistry }) {
  try {
    const result = await toolRegistry.run({
      name: "official-tool-sync",
      chatId,
      request: { args: { action: "update-safe" } }
    });
    const sync = parseToolSyncOutput(result);
    return {
      updated: (sync.updates || []).filter((item) => item.action === "updated").map((item) => item.name),
      skipped: (sync.skipped || []).map(({ name, status }) => ({ name, status }))
    };
  } finally {
    await toolRegistry.load();
  }
}

function shortToolStatus(status) {
  return ({
    "locally-modified": "local",
    "untracked-difference": "untracked",
    "update-available": "update",
    "baseline-refresh": "refresh",
    "up-to-date": "current"
  })[status] || status;
}

export function formatUpdateReport(report) {
  const lines = ["Arisa update", "============", "Core"];
  lines.push(...reportRow("Current", report.core.currentVersion));
  lines.push(...reportRow("Latest", report.core.latestVersion));
  lines.push(...reportRow("Status", report.core.updateAvailable ? "update available" : "up to date"));
  lines.push("", "Official tools");
  lines.push(...reportRow("Installed", report.tools.installedOfficial));
  for (const [status, count] of Object.entries(report.tools.counts)) {
    lines.push(...reportRow(status, count, { labelWidth: 20 }));
  }
  lines.push("", `Official (${report.tools.official.length})`);
  for (const item of report.tools.official) {
    const status = shortToolStatus(item.status);
    const suffix = status === "current" ? "" : ` [${status}]`;
    lines.push(...wrapReportText(`${item.name}${suffix}`, { firstPrefix: "  - ", nextPrefix: "    " }));
  }
  lines.push("", `Non-official (${report.tools.nonOfficial.length})`);
  if (!report.tools.nonOfficial.length) lines.push("  (none)");
  for (const name of report.tools.nonOfficial) {
    lines.push(...wrapReportText(name, { firstPrefix: "  - ", nextPrefix: "    " }));
  }
  if (report.tools.updateable.length) {
    lines.push("", "Safe updates");
    for (const name of report.tools.updateable) lines.push(...wrapReportText(name, { firstPrefix: "  - ", nextPrefix: "    " }));
  }
  if (report.tools.blocked.length) {
    lines.push("", "Needs review");
    for (const item of report.tools.blocked) {
      lines.push(...wrapReportText(item.name, { firstPrefix: "  - ", nextPrefix: "    " }));
      lines.push(...wrapReportText(`[${shortToolStatus(item.status)}]`, { firstPrefix: "    ", nextPrefix: "    " }));
    }
  }
  if (report.bootstrapInstalled.length) {
    lines.push("", "Update support installed");
    for (const name of report.bootstrapInstalled) lines.push(...wrapReportText(name, { firstPrefix: "  - ", nextPrefix: "    " }));
  }
  return renderTextReport(lines);
}
