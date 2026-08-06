import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { validatePrimeBinary } from "../core/agent/prime-rpc-session.js";
import { primeRuntimesDir } from "./paths.js";

export const defaultPrimeReleaseBaseUrl = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev";

const installLockStaleMs = 10 * 60 * 1000;
const installLockTimeoutMs = 5 * 60 * 1000;
const installLockPollMs = 250;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function normalizePrimeVersion(value) {
  const version = String(value || "").trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid Prime Agent version: ${value || "missing"}`);
  }
  return version;
}

function normalizeBaseUrl(value) {
  const baseUrl = String(value || "").trim().replace(/\/+$/, "");
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:") {
    throw new Error(`Prime Agent release URL must use HTTPS: ${baseUrl}`);
  }
  return baseUrl;
}

export function getManagedPrimePaths(version, { runtimesRoot = primeRuntimesDir } = {}) {
  const normalizedVersion = normalizePrimeVersion(version);
  const runtimeDir = path.join(runtimesRoot, normalizedVersion);
  const packageDir = path.join(runtimeDir, "node_modules", "prime-agent");
  return {
    version: normalizedVersion,
    runtimeDir,
    packageDir,
    cliPath: path.join(packageDir, "dist", "bundle", "cli.js"),
    markerFile: path.join(runtimeDir, "arisa-runtime.json"),
    lockFile: path.join(runtimesRoot, `.install-${normalizedVersion}.lock`)
  };
}

export function parsePrimeChecksumManifest(contents, filename) {
  const safeFilename = String(filename || "").trim();
  if (!safeFilename || path.basename(safeFilename) !== safeFilename) {
    throw new Error(`Invalid Prime Agent tarball name: ${filename || "missing"}`);
  }

  for (const rawLine of String(contents || "").split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(rawLine.trim());
    if (match && match[2] === safeFilename) return match[1].toLowerCase();
  }
  throw new Error(`Prime Agent checksum not found for ${safeFilename}`);
}

async function fetchOrThrow(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: "follow" });
  } catch (error) {
    throw new Error(`Could not download ${url}: ${errorMessage(error)}`);
  }
  if (!response?.ok) {
    throw new Error(`Could not download ${url}: HTTP ${response?.status || "unknown"}`);
  }
  return response;
}

async function downloadFile(fetchImpl, url, targetFile) {
  const response = await fetchOrThrow(fetchImpl, url);
  if (!response.body) throw new Error(`Could not download ${url}: empty response body`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(targetFile, { flags: "wx", mode: 0o600 }));
}

export async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyPrimeTarball(file, expectedSha256) {
  const actualSha256 = await sha256File(file);
  if (actualSha256 !== String(expectedSha256 || "").toLowerCase()) {
    throw new Error(`Prime Agent checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`);
  }
  return actualSha256;
}

function resolveNpmInvocation({ env = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  const npmExecPath = String(env.npm_execpath || "").trim();
  if (npmExecPath && path.isAbsolute(npmExecPath) && path.basename(npmExecPath) === "npm-cli.js") {
    return { command: execPath, commandArgs: [npmExecPath] };
  }
  const adjacentNpmCli = path.resolve(path.dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(adjacentNpmCli)) return { command: execPath, commandArgs: [adjacentNpmCli] };
  return { command: platform === "win32" ? "npm.cmd" : "npm", commandArgs: [] };
}

async function runProcess(command, args, { cwd, env, spawnImpl = spawn } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed${signal ? ` with ${signal}` : ` with exit code ${exitCode}`}: ${command}`));
    });
  });
}

async function isManagedPrimeReady(paths) {
  try {
    const marker = JSON.parse(await readFile(paths.markerFile, "utf8"));
    if (marker.version !== paths.version) return false;
    await access(paths.cliPath);
    return true;
  } catch {
    return false;
  }
}

async function acquireInstallLock(paths) {
  const deadline = Date.now() + installLockTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const handle = await open(paths.lockFile, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      return handle;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await isManagedPrimeReady(paths)) return null;
      try {
        const lockStat = await stat(paths.lockFile);
        if (Date.now() - lockStat.mtimeMs > installLockStaleMs) {
          await unlink(paths.lockFile);
          continue;
        }
      } catch (lockError) {
        if (lockError?.code !== "ENOENT") throw lockError;
      }
      await delay(installLockPollMs);
    }
  }
  throw new Error(`Timed out waiting for Prime Agent v${paths.version} installation`);
}

async function releaseInstallLock(paths, handle) {
  if (!handle) return;
  await handle.close().catch(() => {});
  await unlink(paths.lockFile).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function replaceRuntimeDirectory(stagingDir, runtimeDir) {
  const backupDir = `${runtimeDir}.previous-${crypto.randomUUID()}`;
  let backedUp = false;
  try {
    await rename(runtimeDir, backupDir);
    backedUp = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  try {
    await rename(stagingDir, runtimeDir);
  } catch (error) {
    if (backedUp) await rename(backupDir, runtimeDir).catch(() => {});
    throw error;
  }

  if (backedUp) await rm(backupDir, { recursive: true, force: true }).catch(() => {});
}

function managedPrimeResolution(paths) {
  return {
    command: process.execPath,
    commandArgs: [paths.cliPath],
    managed: true,
    runtimeDir: paths.runtimeDir,
    version: paths.version
  };
}

function getStagingPrimePaths(stagingDir) {
  const packageDir = path.join(stagingDir, "node_modules", "prime-agent");
  return {
    runtimeDir: stagingDir,
    packageDir,
    cliPath: path.join(packageDir, "dist", "bundle", "cli.js"),
    markerFile: path.join(stagingDir, "arisa-runtime.json")
  };
}

export async function installManagedPrimeAgent({
  version,
  baseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL || defaultPrimeReleaseBaseUrl,
  runtimesRoot = primeRuntimesDir,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  validateImpl = validatePrimeBinary,
  logger
} = {}) {
  const paths = getManagedPrimePaths(version, { runtimesRoot });
  if (await isManagedPrimeReady(paths)) return managedPrimeResolution(paths);

  await mkdir(runtimesRoot, { recursive: true, mode: 0o700 });
  const lockHandle = await acquireInstallLock(paths);
  if (!lockHandle) return managedPrimeResolution(paths);

  let stagingDir = "";
  try {
    if (await isManagedPrimeReady(paths)) return managedPrimeResolution(paths);
    const releaseBaseUrl = normalizeBaseUrl(baseUrl);
    const tarballName = `prime-agent-${paths.version}.tgz`;
    const releaseUrl = `${releaseBaseUrl}/releases/v${paths.version}`;
    const checksumsUrl = `${releaseUrl}/SHA256SUMS`;
    const tarballUrl = `${releaseUrl}/${tarballName}`;

    logger?.log("prime", `installing managed Prime Agent v${paths.version}`);
    stagingDir = await mkdtemp(path.join(runtimesRoot, `.install-${paths.version}-`));
    const tarballFile = path.join(stagingDir, tarballName);
    const checksumResponse = await fetchOrThrow(fetchImpl, checksumsUrl);
    const expectedSha256 = parsePrimeChecksumManifest(await checksumResponse.text(), tarballName);
    await downloadFile(fetchImpl, tarballUrl, tarballFile);
    await verifyPrimeTarball(tarballFile, expectedSha256);

    const npm = resolveNpmInvocation();
    const npmCacheDir = path.join(stagingDir, ".npm-cache");
    await mkdir(npmCacheDir, { recursive: true, mode: 0o700 });
    await runProcess(npm.command, [
      ...npm.commandArgs,
      "install",
      "--prefix", stagingDir,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      "--progress=false",
      tarballFile
    ], {
      cwd: stagingDir,
      env: {
        ...process.env,
        npm_config_cache: npmCacheDir,
        npm_config_update_notifier: "false"
      },
      spawnImpl
    });

    const stagingPaths = getStagingPrimePaths(stagingDir);
    await access(stagingPaths.cliPath);
    await validateImpl({
      command: process.execPath,
      commandArgs: [stagingPaths.cliPath],
      expectedVersion: paths.version
    });
    await rm(npmCacheDir, { recursive: true, force: true });
    await writeFile(stagingPaths.markerFile, `${JSON.stringify({
      name: "prime-agent",
      version: paths.version,
      source: tarballUrl,
      sha256: expectedSha256,
      installedAt: new Date().toISOString()
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    await replaceRuntimeDirectory(stagingDir, paths.runtimeDir);
    stagingDir = "";
    logger?.log("prime", `managed Prime Agent v${paths.version} is ready`);
    return managedPrimeResolution(paths);
  } catch (error) {
    throw new Error(`Could not install Prime Agent v${paths.version}: ${errorMessage(error)}`);
  } finally {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    await releaseInstallLock(paths, lockHandle);
  }
}

export async function resolvePrimeAgentRuntime({ command, version, ...options } = {}) {
  const configuredCommand = String(command || "").trim();
  if (configuredCommand) {
    return {
      command: configuredCommand,
      commandArgs: [],
      managed: false,
      runtimeDir: "",
      version: normalizePrimeVersion(version)
    };
  }
  return installManagedPrimeAgent({ version, ...options });
}
