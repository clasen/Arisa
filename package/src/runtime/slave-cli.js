import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyConfigDefaults } from "../core/config/config-defaults.js";
import { installLockedOfficialTool } from "../core/tools/official-tool-installer.js";
import { createHeadlessApp } from "./create-headless-app.js";
import { arisaPackageDir } from "./paths.js";
import { readPackageVersion, readRecentLogLines, followLogFile } from "./log-viewer.js";
import { parseSlaveBootstrapUrl } from "./slave-bootstrap-url.js";
import { withSecureRequestFile } from "./secure-request-file.js";
import {
  controlSlaveService,
  getSlavePaths,
  installSlaveSystemdService,
  isSlaveToolInstalled,
  readSlaveServiceDescriptor,
  registerSlaveServiceProcess,
  resolveSlaveHome,
  selectSlaveServiceAccount,
  unregisterSlaveServiceProcess,
  writeSlaveServiceDescriptor
} from "./slave-service.js";

const toolName = "master-slave";
const toolLockFile = new URL("../official-tools.lock.json", import.meta.url);

function exists(target) {
  return access(target).then(() => true, () => false);
}

function runProcess(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let diagnostics = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { diagnostics += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve({ stdout: output, stderr: diagnostics });
      else reject(new Error(`master-slave command failed (${signal || code}): ${diagnostics.trim().slice(-1000)}`));
    });
  });
}

export async function ensureSlaveConfig(paths) {
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  await mkdir(paths.toolsDir, { recursive: true, mode: 0o700 });
  if (await exists(paths.configFile)) return { created: false, configFile: paths.configFile };
  const config = applyConfigDefaults({ role: "slave", createdAt: new Date().toISOString() });
  await writeFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { created: true, configFile: paths.configFile };
}

export async function ensureMasterSlaveTool(paths, {
  install = installLockedOfficialTool,
  readLock = async () => JSON.parse(await readFile(toolLockFile, "utf8"))
} = {}) {
  if (await isSlaveToolInstalled(paths, toolName)) return { installed: false };
  let lock;
  try {
    lock = await readLock();
  } catch (error) {
    throw new Error("This Arisa build does not include the verified master-slave tool lock", { cause: error });
  }
  const result = await install({
    toolName,
    lock,
    destination: path.join(paths.toolsDir, toolName)
  });
  return { installed: true, ...result };
}

export async function invokeSlaveTool(paths, args, { run = runProcess } = {}) {
  const toolDir = path.join(paths.toolsDir, toolName);
  const manifest = JSON.parse(await readFile(path.join(toolDir, "tool.manifest.json"), "utf8"));
  const entry = path.join(toolDir, manifest.entry || "index.js");
  return withSecureRequestFile({
    directory: paths.tmpDir,
    prefix: "tool-request",
    value: { args }
  }, async (requestFile) => {
    const result = await run(process.execPath, [entry, "run", "--request-file", requestFile], {
      cwd: toolDir,
      env: {
        ...process.env,
        ARISA_HOME: paths.home,
        ARISA_SLAVE_HOME: paths.home,
        ARISA_PACKAGE_DIR: arisaPackageDir,
        ARISA_IPC_SOCKET: paths.ipcSocket || ""
      }
    });
    const text = result.stdout.trim();
    if (!text) throw new Error("master-slave returned no response");
    const parsed = JSON.parse(text);
    if (parsed.ok === false) throw new Error(parsed.error || "master-slave request failed");
    return parsed;
  });
}

async function listSlaveTools(paths) {
  const entries = await readdir(paths.toolsDir, { withFileTypes: true }).catch(() => []);
  const tools = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(path.join(paths.toolsDir, entry.name, "tool.manifest.json"), "utf8"));
      tools.push({ name: manifest.name, description: manifest.description || "" });
    } catch {}
  }
  return tools.sort((left, right) => left.name.localeCompare(right.name));
}

async function showSlaveLogs(paths, { follow, output = process.stdout, signal } = {}) {
  const version = await readPackageVersion();
  const snapshot = await readRecentLogLines(paths.logFile, 100);
  output.write(`Arisa Slave v${version} | Recent logs\n`);
  output.write(`${follow ? "Following new logs; press Ctrl+C to exit." : "Log follow disabled."}\n\n`);
  if (snapshot.text) output.write(`${snapshot.text}${snapshot.endsWithNewline ? "\n" : ""}`);
  else output.write("No logs yet.\n");
  if (!follow) return;
  await followLogFile({
    logFile: paths.logFile,
    initialSize: snapshot.size,
    initialIno: snapshot.ino,
    write: (content) => output.write(content),
    signal
  });
}

function parseSlaveToolOutput(result) {
  if (result?.output?.json && typeof result.output.json === "object") return result.output.json;
  if (typeof result?.output?.text === "string") {
    try {
      return JSON.parse(result.output.text);
    } catch {}
  }
  return result?.output && typeof result.output === "object" ? result.output : result;
}

export function formatSlaveStatus({ systemd, diagnostic }) {
  const jobs = diagnostic?.jobs && typeof diagnostic.jobs === "object" ? diagnostic.jobs : {};
  return [
    "Arisa Slave status",
    `Systemd: ${systemd.running ? "active" : systemd.status || "inactive"}`,
    `Daemon: ${diagnostic?.daemon?.state || diagnostic?.daemonState || "unknown"}`,
    `Role: ${diagnostic?.role || "unknown"}`,
    `Endpoint: ${diagnostic?.endpoint || "not configured"}`,
    `Identity: ${diagnostic?.identityFingerprint || diagnostic?.identity || "not configured"}`,
    `Paired: ${diagnostic?.paired === true ? "yes" : diagnostic?.paired === false ? "no" : "unknown"}`,
    `Connected: ${diagnostic?.network?.connected === true ? "yes" : diagnostic?.network?.connected === false ? "no" : "unknown"}`,
    `Tools: ${Number.isSafeInteger(diagnostic?.toolCount) ? diagnostic.toolCount : "unknown"}`,
    `Jobs: active=${jobs.active ?? "unknown"}, queued=${jobs.queued ?? "unknown"}, failed=${jobs.failed ?? "unknown"}`,
    `Pending secrets: ${Number.isSafeInteger(diagnostic?.pendingSecrets) ? diagnostic.pendingSecrets : "unknown"}`
  ].join("\n");
}

function explainSlaveBootstrapError(error) {
  if (error?.message !== "Socket closed before the protocol completed") return error;
  return new Error(
    "Master ended the pairing handshake before it completed. The bootstrap URL may be expired, rotated, already used, or invalid. Generate a new bootstrap URL on Master and retry before it expires.",
    { cause: error }
  );
}

export async function runSlaveBootstrap(url, {
  paths = getSlavePaths(resolveSlaveHome()),
  selectAccount = selectSlaveServiceAccount,
  ensureTool = ensureMasterSlaveTool,
  installService = installSlaveSystemdService,
  invokeTool = invokeSlaveTool,
  entryFile,
  output = console,
  platform = process.platform
} = {}) {
  parseSlaveBootstrapUrl(url);
  if (platform !== "linux") throw new Error("Arisa Slave service installation currently requires Linux with systemd");
  const account = await selectAccount();
  await ensureSlaveConfig(paths);
  await ensureTool(paths);
  let result;
  try {
    result = await withSecureRequestFile({
      directory: paths.tmpDir,
      prefix: "bootstrap",
      value: { url }
    }, (bootstrapFile) => invokeTool(paths, { action: "slave.bootstrap", bootstrapFile }));
  } catch (error) {
    throw explainSlaveBootstrapError(error);
  }
  await installService({ account, slaveHome: paths.home, entryFile });
  await writeSlaveServiceDescriptor(paths, { version: 1, account, installedAt: new Date().toISOString() });
  output.log(`Arisa Slave paired and running as ${account.user}${account.root ? " (root)" : ""}.`);
  return result;
}

export async function runSlaveService({ paths = getSlavePaths(resolveSlaveHome()), logger } = {}) {
  await ensureSlaveConfig(paths);
  await registerSlaveServiceProcess(paths);
  const app = await createHeadlessApp({ logger });
  try {
    await app.start();
    return app;
  } catch (error) {
    await unregisterSlaveServiceProcess(paths);
    throw error;
  }
}

export async function runSlaveCli({
  positionals = [],
  flags = {},
  logger,
  entryFile,
  output = console,
  paths = getSlavePaths(resolveSlaveHome()),
  controlService = controlSlaveService,
  invokeTool = invokeSlaveTool,
  toolInstalled = isSlaveToolInstalled
} = {}) {
  if (flags["service-runner"]) {
    const app = await runSlaveService({ paths, logger });
    return { serviceRunner: true, app, paths };
  }

  const action = positionals[0];
  if (flags.help || action === "help") {
    output.log("Usage: arisa slave <tcp://ip:port/secret> | start | stop | restart | status | log | tools | unpair");
    return { help: true };
  }
  if (action?.startsWith("tcp://")) {
    if (positionals.length !== 1) throw new Error("arisa slave accepts exactly one bootstrap URL");
    return runSlaveBootstrap(action, { paths, entryFile, output });
  }
  if (["start", "stop", "restart"].includes(action)) {
    if (positionals.length !== 1) throw new Error(`arisa slave ${action} does not accept additional arguments`);
    const result = await controlService(paths, action);
    output.log(`Arisa Slave ${action} requested.`);
    return result;
  }
  if (action === "status") {
    if (positionals.length !== 1) throw new Error("arisa slave status does not accept additional arguments");
    const systemd = await controlService(paths, "status");
    const diagnostic = await toolInstalled(paths, toolName)
      ? parseSlaveToolOutput(await invokeTool(paths, { action: "slave.status" }))
      : { daemonState: "not-installed", role: "slave", paired: false, toolCount: 0, pendingSecrets: 0 };
    output.log(formatSlaveStatus({ systemd, diagnostic }));
    return { systemd, diagnostic };
  }
  if (action === "log") {
    if (positionals.length !== 1) throw new Error("arisa slave log does not accept additional arguments");
    await showSlaveLogs(paths, { follow: !flags["no-follow"] });
    return { ok: true };
  }
  if (action === "tools") {
    if (positionals.length !== 1) throw new Error("arisa slave tools does not accept additional arguments");
    const tools = await listSlaveTools(paths);
    for (const tool of tools) output.log(`${tool.name}${tool.description ? ` — ${tool.description}` : ""}`);
    return { tools };
  }
  if (action === "unpair") {
    if (positionals.length !== 1) throw new Error("arisa slave unpair does not accept additional arguments");
    await readSlaveServiceDescriptor(paths);
    const result = await invokeTool(paths, { action: "slave.unpair" });
    output.log("Arisa Slave unpaired. The local service remains installed and stopped from reconnecting.");
    return result;
  }
  throw new Error("Usage: arisa slave <tcp://ip:port/secret> | start | stop | restart | status | log | tools | unpair");
}
