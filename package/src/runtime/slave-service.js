import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const slaveServiceName = "arisa-slave.service";
export const slaveLaunchdLabel = "com.arisa.slave";
export const slaveWindowsTaskName = "Arisa Slave";

function exists(target) {
  return access(target).then(() => true, () => false);
}

function requireAccountName(value) {
  const name = String(value || "").trim();
  if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(name)) throw new Error(`Invalid service account: ${name || "empty"}`);
  return name;
}

function requireWindowsAccountName(value) {
  const name = String(value || "").trim();
  if (!name || /[\u0000-\u001f<>"|]/.test(name)) throw new Error(`Invalid Windows service account: ${name || "empty"}`);
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
  environment = process.env,
  platform = process.platform
} = {}) {
  if (platform === "win32") {
    const qualifiedUser = environment.USERDOMAIN && environment.USERNAME
      ? `${environment.USERDOMAIN}\\${environment.USERNAME}`
      : currentUser;
    return { scope: "user", user: requireWindowsAccountName(qualifiedUser), root: false, dedicated: false };
  }
  if (euid !== 0) {
    return { scope: "user", user: requireAccountName(currentUser), root: false, dedicated: false };
  }
  const user = requireAccountName(environment.SUDO_USER || currentUser);
  return { scope: "system", user, root: user === "root", dedicated: false };
}

function quoteSystemd(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function escapeSystemdPath(value) {
  const text = String(value);
  if (text.includes("\0")) throw new Error("Systemd paths cannot contain NUL bytes");
  return [...text].map((character) => {
    if (character === "\\") return "\\\\";
    if (character === "%") return "%%";
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x20 || codePoint === 0x7f || character === '"' || character === "'") {
      return `\\x${codePoint.toString(16).padStart(2, "0")}`;
    }
    return character;
  }).join("");
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
    `WorkingDirectory=${escapeSystemdPath(paths.home)}`,
    `ExecStart=${quoteSystemd(nodePath)} ${quoteSystemd(entryFile)} slave --service-runner`,
    `StandardOutput=append:${escapeSystemdPath(paths.logFile)}`,
    `StandardError=append:${escapeSystemdPath(paths.logFile)}`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    account.scope === "system" ? "WantedBy=multi-user.target" : "WantedBy=default.target",
    ""
  ].filter((line, index, lines) => line || lines[index - 1] !== "").join("\n");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistString(value) {
  return `    <string>${escapeXml(value)}</string>`;
}

export function buildSlaveLaunchdPlist({ account, slaveHome, entryFile, nodePath = process.execPath, environment = process.env }) {
  if (!account?.scope || !account?.user) throw new Error("Slave launchd service requires a service account");
  if (typeof entryFile !== "string" || !path.isAbsolute(entryFile)) throw new Error("Slave launchd service requires an absolute Arisa entry file");
  const paths = getSlavePaths(slaveHome);
  const serviceUser = account.scope === "system" && account.user !== "root"
    ? ["  <key>UserName</key>", `  <string>${escapeXml(account.user)}</string>`]
    : [];
  const environmentEntries = {
    ARISA_HOME: paths.home,
    ARISA_SLAVE_HOME: paths.home,
    ...(environment.HOME ? { HOME: environment.HOME } : {}),
    ...(environment.PATH ? { PATH: environment.PATH } : {}),
    ...(environment.TMPDIR ? { TMPDIR: environment.TMPDIR } : {})
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${slaveLaunchdLabel}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    plistString(nodePath),
    plistString(entryFile),
    plistString("slave"),
    plistString("--service-runner"),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(environmentEntries).flatMap(([key, value]) => [
      `    <key>${escapeXml(key)}</key>`,
      `    <string>${escapeXml(value)}</string>`
    ]),
    '  </dict>',
    '  <key>WorkingDirectory</key>',
    `  <string>${escapeXml(paths.home)}</string>`,
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(paths.logFile)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(paths.logFile)}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    ...serviceUser,
    '</dict>',
    '</plist>',
    ''
  ].join("\n");
}

export function buildSlaveWindowsLauncher({ slaveHome, entryFile, nodePath = process.execPath }) {
  if (typeof entryFile !== "string" || !path.isAbsolute(entryFile)) throw new Error("Slave Windows launcher requires an absolute Arisa entry file");
  const paths = getSlavePaths(slaveHome);
  return [
    'const { closeSync, openSync } = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    `const home = ${JSON.stringify(paths.home)};`,
    `const logFile = ${JSON.stringify(paths.logFile)};`,
    `process.env.ARISA_HOME = ${JSON.stringify(paths.home)};`,
    `process.env.ARISA_SLAVE_HOME = ${JSON.stringify(paths.home)};`,
    'process.chdir(home);',
    'const log = openSync(logFile, "a");',
    `const child = spawn(${JSON.stringify(nodePath)}, [${JSON.stringify(entryFile)}, "slave", "--service-runner"], {`,
    '  cwd: home,',
    '  env: process.env,',
    '  stdio: ["ignore", log, log],',
    '  windowsHide: true',
    '});',
    'for (const signal of ["SIGINT", "SIGTERM"]) {',
    '  process.on(signal, () => child.kill(signal));',
    '}',
    'let finished = false;',
    'function finish(code, error) {',
    '  if (finished) return;',
    '  finished = true;',
    '  if (error) require("node:fs").writeSync(log, `${error.stack || error.message || error}\\n`);',
    '  closeSync(log);',
    '  process.exitCode = Number.isInteger(code) ? code : 1;',
    '}',
    'child.once("error", (error) => finish(1, error));',
    'child.once("close", (code) => finish(code));',
    ''
  ].join("\r\n");
}

export function buildSlaveWindowsTaskXml({ account, launcherFile, nodePath = process.execPath }) {
  if (!account?.user) throw new Error("Slave Windows task requires a service account");
  if (typeof launcherFile !== "string" || !path.isAbsolute(launcherFile)) throw new Error("Slave Windows task requires an absolute launcher file");
  const taskArguments = `"${launcherFile}"`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Author>${escapeXml(account.user)}</Author>`,
    '    <Description>Arisa Slave headless host</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${escapeXml(account.user)}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${escapeXml(account.user)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <Enabled>true</Enabled>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>999</Count>',
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(nodePath)}</Command>`,
    `      <Arguments>${escapeXml(taskArguments)}</Arguments>`,
    `      <WorkingDirectory>${escapeXml(path.dirname(launcherFile))}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    ''
  ].join("\r\n");
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
  await execute("systemctl", [...systemctlArgs, "enable", slaveServiceName], { env: environment });
  await execute("systemctl", [...systemctlArgs, "restart", slaveServiceName], { env: environment });
  return { unitFile, serviceName: slaveServiceName, account, paths };
}

export async function installSlaveLaunchdService({
  account,
  slaveHome,
  entryFile,
  execute = runCommand,
  environment = process.env,
  platform = process.platform,
  uid = process.getuid?.(),
  systemUnitDir = "/Library/LaunchDaemons",
  userUnitDir = path.join(os.homedir(), "Library", "LaunchAgents")
}) {
  if (platform !== "darwin") throw new Error("Arisa Slave launchd installation requires macOS");
  if (account.scope === "user" && !Number.isSafeInteger(uid)) throw new Error("Cannot determine the macOS user id for launchd");
  const paths = getSlavePaths(slaveHome);
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  const unitDir = account.scope === "system" ? systemUnitDir : userUnitDir;
  await mkdir(unitDir, { recursive: true });
  const unitFile = path.join(unitDir, `${slaveLaunchdLabel}.plist`);
  await writeFile(unitFile, buildSlaveLaunchdPlist({ account, slaveHome: paths.home, entryFile, environment }), { mode: 0o644 });
  const domain = account.scope === "system" ? "system" : `gui/${uid}`;
  const serviceTarget = `${domain}/${slaveLaunchdLabel}`;
  await execute("launchctl", ["bootout", serviceTarget], { env: environment }).catch(() => {});
  await execute("launchctl", ["bootstrap", domain, unitFile], { env: environment });
  await execute("launchctl", ["enable", serviceTarget], { env: environment });
  await execute("launchctl", ["kickstart", "-k", serviceTarget], { env: environment });
  return { unitFile, serviceName: slaveLaunchdLabel, serviceManager: "launchd", serviceTarget, account, paths };
}

export async function installSlaveWindowsService({
  account,
  slaveHome,
  entryFile,
  execute = runCommand,
  platform = process.platform
}) {
  if (platform !== "win32") throw new Error("Arisa Slave Task Scheduler installation requires Windows");
  const paths = getSlavePaths(slaveHome);
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  const launcherFile = path.join(paths.state, "arisa-slave-launcher.cjs");
  const unitFile = path.join(paths.state, "arisa-slave-task.xml");
  await writeFile(launcherFile, `\uFEFF${buildSlaveWindowsLauncher({ slaveHome: paths.home, entryFile })}`, { encoding: "utf8", mode: 0o600 });
  await writeFile(unitFile, `\uFEFF${buildSlaveWindowsTaskXml({ account, launcherFile })}`, { encoding: "utf16le", mode: 0o600 });
  await execute("schtasks.exe", ["/End", "/TN", slaveWindowsTaskName]).catch(() => {});
  await execute("schtasks.exe", ["/Create", "/TN", slaveWindowsTaskName, "/XML", unitFile, "/F"]);
  await execute("schtasks.exe", ["/Run", "/TN", slaveWindowsTaskName]);
  return {
    unitFile,
    launcherFile,
    serviceName: slaveWindowsTaskName,
    serviceManager: "windows-task",
    serviceTarget: slaveWindowsTaskName,
    account,
    paths
  };
}

export async function installSlaveService(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "linux") return installSlaveSystemdService({ ...options, platform });
  if (platform === "darwin") return installSlaveLaunchdService({ ...options, platform });
  if (platform === "win32") return installSlaveWindowsService({ ...options, platform });
  throw new Error(`Arisa Slave service installation is not supported on ${platform}`);
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

async function controlSystemdService(descriptor, operation, execute) {
  const prefix = descriptor.account?.scope === "user" ? ["--user"] : [];
  if (operation === "status") {
    try {
      const result = await execute("systemctl", [...prefix, "is-active", slaveServiceName]);
      return { running: result.stdout.trim() === "active", status: result.stdout.trim(), serviceManager: "systemd" };
    } catch {
      return { running: false, status: "inactive", serviceManager: "systemd" };
    }
  }
  await execute("systemctl", [...prefix, operation, slaveServiceName]);
  return { ok: true, operation, serviceManager: "systemd" };
}

async function launchdIsLoaded(serviceTarget, execute) {
  try {
    await execute("launchctl", ["print", serviceTarget]);
    return true;
  } catch {
    return false;
  }
}

async function controlLaunchdService(descriptor, operation, execute) {
  const serviceTarget = descriptor.serviceTarget;
  const unitFile = descriptor.unitFile;
  const domain = serviceTarget?.slice(0, serviceTarget.lastIndexOf("/"));
  if (!serviceTarget || !unitFile || !domain) throw new Error("Arisa Slave launchd descriptor is incomplete");
  const loaded = await launchdIsLoaded(serviceTarget, execute);
  if (operation === "status") {
    return { running: loaded, status: loaded ? "active" : "inactive", serviceManager: "launchd" };
  }
  if (operation === "stop") {
    if (loaded) await execute("launchctl", ["bootout", serviceTarget]);
    return { ok: true, operation, serviceManager: "launchd" };
  }
  if (!loaded) await execute("launchctl", ["bootstrap", domain, unitFile]);
  await execute("launchctl", ["enable", serviceTarget]);
  await execute("launchctl", ["kickstart", ...(operation === "restart" ? ["-k"] : []), serviceTarget]);
  return { ok: true, operation, serviceManager: "launchd" };
}

async function registeredSlavePidIsAlive(paths) {
  try {
    const pid = Number.parseInt((await readFile(paths.pidFile, "utf8")).trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function controlWindowsTask(paths, descriptor, operation, execute) {
  const taskName = descriptor.serviceTarget || slaveWindowsTaskName;
  if (operation === "status") {
    try {
      await execute("schtasks.exe", ["/Query", "/TN", taskName]);
      const running = await registeredSlavePidIsAlive(paths);
      return { running, status: running ? "active" : "inactive", serviceManager: "windows-task" };
    } catch {
      return { running: false, status: "not-installed", serviceManager: "windows-task" };
    }
  }
  if (operation === "stop" || operation === "restart") {
    await execute("schtasks.exe", ["/End", "/TN", taskName]).catch(() => {});
  }
  if (operation === "start" || operation === "restart") {
    await execute("schtasks.exe", ["/Run", "/TN", taskName]);
  }
  return { ok: true, operation, serviceManager: "windows-task" };
}

export async function controlSlaveService(paths, operation, { execute = runCommand } = {}) {
  if (!["start", "stop", "restart", "status"].includes(operation)) throw new Error(`Unsupported Slave service operation: ${operation}`);
  const descriptor = await readSlaveServiceDescriptor(paths);
  if (descriptor.serviceManager === "launchd") return controlLaunchdService(descriptor, operation, execute);
  if (descriptor.serviceManager === "windows-task") return controlWindowsTask(paths, descriptor, operation, execute);
  return controlSystemdService(descriptor, operation, execute);
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
