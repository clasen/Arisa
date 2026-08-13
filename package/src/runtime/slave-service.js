import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const slaveServiceName = "arisa-slave.service";

function exists(target) {
  return access(target).then(() => true, () => false);
}

function requireAccountName(value) {
  const name = String(value || "").trim();
  if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(name)) throw new Error(`Invalid service account: ${name || "empty"}`);
  return name;
}

export function resolveSlaveHome({ environment = process.env, euid = process.geteuid?.(), homedir = os.homedir() } = {}) {
  if (environment.ARISA_SLAVE_HOME) return path.resolve(environment.ARISA_SLAVE_HOME);
  return euid === 0 ? "/var/lib/arisa-slave" : path.join(homedir, ".arisa-slave");
}

export function getSlavePaths(slaveHome) {
  const home = path.resolve(slaveHome);
  const state = path.join(home, "state");
  return {
    home,
    state,
    configFile: path.join(state, "config.json"),
    descriptorFile: path.join(state, "service.json"),
    pidFile: path.join(state, "arisa-slave.pid"),
    logFile: path.join(state, "arisa-slave.log"),
    ipcSocket: process.platform === "win32" ? null : path.join(state, "arisa.sock"),
    toolsDir: path.join(home, "tools"),
    tmpDir: path.join(state, "tmp")
  };
}

export async function selectSlaveServiceAccount({
  euid = process.geteuid?.(),
  currentUser = os.userInfo().username,
  ask
} = {}) {
  if (euid !== 0) {
    return { scope: "user", user: requireAccountName(currentUser), root: false, dedicated: false };
  }
  if (typeof ask !== "function") throw new Error("Running Arisa Slave as UID 0 requires an explicit account selection");
  const choice = String(await ask([
    "Run Arisa Slave as:",
    "1. dedicated user arisa-slave (recommended)",
    "2. another existing user",
    "3. root",
    "Selection"
  ].join("\n"))).trim();
  if (choice === "1") return { scope: "system", user: "arisa-slave", root: false, dedicated: true };
  if (choice === "2") {
    return { scope: "system", user: requireAccountName(await ask("Existing service user")), root: false, dedicated: false };
  }
  if (choice === "3") {
    const confirmation = String(await ask("Type RUN AS ROOT to confirm full root authority")).trim();
    if (confirmation !== "RUN AS ROOT") throw new Error("Root execution was not confirmed");
    return { scope: "system", user: "root", root: true, dedicated: false };
  }
  throw new Error("Invalid Arisa Slave service account selection");
}

function quoteSystemd(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildSlaveSystemdUnit({ account, slaveHome, entryFile, nodePath = process.execPath }) {
  if (!account?.scope || !account?.user) throw new Error("Slave systemd unit requires a service account");
  if (typeof entryFile !== "string" || !path.isAbsolute(entryFile)) throw new Error("Slave systemd unit requires an absolute Arisa entry file");
  const paths = getSlavePaths(slaveHome);
  const userDirective = account.scope === "system" ? `User=${account.user}\n` : "";
  return [
    "[Unit]",
    "Description=Arisa Slave headless host",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    userDirective.trimEnd(),
    `Environment=${quoteSystemd(`ARISA_HOME=${paths.home}`)}`,
    `Environment=${quoteSystemd(`ARISA_SLAVE_HOME=${paths.home}`)}`,
    `WorkingDirectory=${quoteSystemd(paths.home)}`,
    `ExecStart=${quoteSystemd(nodePath)} ${quoteSystemd(entryFile)} slave --service-runner`,
    `StandardOutput=append:${paths.logFile}`,
    `StandardError=append:${paths.logFile}`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    account.scope === "system" ? "WantedBy=multi-user.target" : "WantedBy=default.target",
    ""
  ].filter((line, index, lines) => line || lines[index - 1] !== "").join("\n");
}

export function runCommand(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} failed (${signal || code}): ${(stderr || stdout).trim().slice(-1000)}`));
    });
  });
}

async function ensureSystemAccount(account, execute) {
  if (account.scope !== "system" || account.user === "root") return "root";
  try {
    await execute("id", ["-u", account.user]);
  } catch (error) {
    if (!account.dedicated) throw new Error(`Service user does not exist: ${account.user}`, { cause: error });
    await execute("useradd", ["--system", "--home-dir", "/var/lib/arisa-slave", "--create-home", "--shell", "/usr/sbin/nologin", account.user]);
  }
  return (await execute("id", ["-gn", account.user])).stdout.trim();
}

export async function installSlaveSystemdService({
  account,
  slaveHome,
  entryFile,
  execute = runCommand,
  environment = process.env,
  platform = process.platform,
  systemUnitDir = "/etc/systemd/system",
  userUnitDir = path.join(os.homedir(), ".config", "systemd", "user")
}) {
  if (platform !== "linux") throw new Error("Arisa Slave service installation currently requires Linux with systemd");
  const accountGroup = await ensureSystemAccount(account, execute);
  const paths = getSlavePaths(slaveHome);
  if (account.scope === "system") {
    await execute("install", ["-d", "-m", "0700", "-o", account.user, "-g", accountGroup, paths.home]);
  } else {
    await mkdir(paths.state, { recursive: true, mode: 0o700 });
  }
  const unitDir = account.scope === "system"
    ? systemUnitDir
    : userUnitDir;
  await mkdir(unitDir, { recursive: true });
  const unitFile = path.join(unitDir, slaveServiceName);
  await writeFile(unitFile, buildSlaveSystemdUnit({ account, slaveHome: paths.home, entryFile }), { mode: 0o644 });
  if (account.scope === "system") {
    await execute("chown", ["-R", `${account.user}:${accountGroup}`, paths.home]);
  }
  const systemctlArgs = account.scope === "user" ? ["--user"] : [];
  await execute("systemctl", [...systemctlArgs, "daemon-reload"], { env: environment });
  await execute("systemctl", [...systemctlArgs, "enable", "--now", slaveServiceName], { env: environment });
  return { unitFile, serviceName: slaveServiceName, account, paths };
}

export async function writeSlaveServiceDescriptor(paths, descriptor) {
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  await writeFile(paths.descriptorFile, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
}

export async function readSlaveServiceDescriptor(paths) {
  try {
    return JSON.parse(await readFile(paths.descriptorFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("Arisa Slave service is not installed");
    throw error;
  }
}

export async function controlSlaveService(paths, operation, { execute = runCommand } = {}) {
  const descriptor = await readSlaveServiceDescriptor(paths);
  const prefix = descriptor.account?.scope === "user" ? ["--user"] : [];
  if (operation === "status") {
    try {
      const result = await execute("systemctl", [...prefix, "is-active", slaveServiceName]);
      return { running: result.stdout.trim() === "active", status: result.stdout.trim() };
    } catch {
      return { running: false, status: "inactive" };
    }
  }
  if (!["start", "stop", "restart"].includes(operation)) throw new Error(`Unsupported Slave service operation: ${operation}`);
  await execute("systemctl", [...prefix, operation, slaveServiceName]);
  return { ok: true, operation };
}

export async function registerSlaveServiceProcess(paths) {
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  let registeredPid = null;
  try {
    registeredPid = Number.parseInt((await readFile(paths.pidFile, "utf8")).trim(), 10);
  } catch {}
  if (Number.isSafeInteger(registeredPid) && registeredPid > 0 && registeredPid !== process.pid) {
    try {
      process.kill(registeredPid, 0);
      throw new Error(`Arisa Slave is already running (pid ${registeredPid})`);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  const handle = await open(paths.pidFile, "w", 0o600);
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function unregisterSlaveServiceProcess(paths) {
  try {
    const registeredPid = Number.parseInt((await readFile(paths.pidFile, "utf8")).trim(), 10);
    if (registeredPid !== process.pid) return false;
    await rm(paths.pidFile, { force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function isSlaveToolInstalled(paths, toolName = "master-slave") {
  return exists(path.join(paths.toolsDir, toolName, "tool.manifest.json"));
}
