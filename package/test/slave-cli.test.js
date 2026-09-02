import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHeadlessApp } from "../src/runtime/create-headless-app.js";
import { parseSlaveBootstrapUrl } from "../src/runtime/slave-bootstrap-url.js";
import { withSecureRequestFile } from "../src/runtime/secure-request-file.js";
import { ensureMasterSlaveTool, formatSlaveStatus, runSlaveBootstrap, runSlaveCli } from "../src/runtime/slave-cli.js";
import {
  buildSlaveLaunchdPlist,
  buildSlaveSystemdUnit,
  buildSlaveWindowsLauncher,
  buildSlaveWindowsTaskXml,
  controlSlaveService,
  getSlavePaths,
  installSlaveLaunchdService,
  installSlaveSystemdService,
  installSlaveWindowsService,
  registerSlaveServiceProcess,
  selectSlaveServiceAccount
} from "../src/runtime/slave-service.js";

const secret = `arisa_secret_v1_${"a".repeat(43)}`;

test("strictly parses IPv4 and bracketed IPv6 Slave bootstrap URLs", () => {
  assert.deepEqual(parseSlaveBootstrapUrl(`tcp://198.51.100.12:4719/${secret}`), {
    endpoint: "tcp://198.51.100.12:4719",
    host: "198.51.100.12",
    ipVersion: 4,
    port: 4719,
    secret,
    url: `tcp://198.51.100.12:4719/${secret}`
  });
  assert.equal(parseSlaveBootstrapUrl(`tcp://[2001:db8::1]:4719/${secret}`).ipVersion, 6);
});

test("rejects non-literal hosts and every extra URL component", () => {
  for (const invalid of [
    `https://198.51.100.12:4719/${secret}`,
    `tcp://master.example:4719/${secret}`,
    `tcp://198.51.100.12/${secret}`,
    `tcp://user@198.51.100.12:4719/${secret}`,
    `tcp://198.51.100.12:4719/${secret}/extra`,
    `tcp://198.51.100.12:4719/${secret}?`,
    `tcp://198.51.100.12:4719/${secret}#fragment`,
    "tcp://198.51.100.12:4719/short"
  ]) {
    assert.throws(() => parseSlaveBootstrapUrl(invalid));
  }
});

test("hands one-shot requests through a 0600 file and removes it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-secure-request-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let handedFile;
  const result = await withSecureRequestFile({ directory: root, value: { secret } }, async (file) => {
    handedFile = file;
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { secret });
    return "consumed";
  });
  assert.equal(result, "consumed");
  await assert.rejects(() => access(handedFile), { code: "ENOENT" });
});

test("selects the invoking service account without prompting", async () => {
  assert.deepEqual(
    await selectSlaveServiceAccount({ euid: 1000, currentUser: "storybot", environment: {} }),
    { scope: "user", user: "storybot", root: false, dedicated: false }
  );
  assert.deepEqual(
    await selectSlaveServiceAccount({
      euid: 0,
      currentUser: "root",
      environment: { SUDO_USER: "storybot" }
    }),
    { scope: "system", user: "storybot", root: false, dedicated: false }
  );
  assert.deepEqual(
    await selectSlaveServiceAccount({ euid: 0, currentUser: "root", environment: {} }),
    { scope: "system", user: "root", root: true, dedicated: false }
  );
  assert.deepEqual(
    await selectSlaveServiceAccount({
      platform: "win32",
      currentUser: "martin.clasen",
      environment: { USERDOMAIN: "MCL4SEN", USERNAME: "martin.clasen" }
    }),
    { scope: "user", user: "MCL4SEN\\martin.clasen", root: false, dedicated: false }
  );
});

test("builds a dedicated headless systemd service with isolated state", () => {
  const unit = buildSlaveSystemdUnit({
    account: { scope: "system", user: "arisa-slave" },
    slaveHome: "/var/lib/arisa-slave",
    entryFile: "/opt/arisa/src/index.js",
    platform: "linux",
    nodePath: "/usr/bin/node"
  });
  assert.match(unit, /User=arisa-slave/);
  assert.match(unit, /Environment="ARISA_HOME=\/var\/lib\/arisa-slave"/);
  assert.match(unit, /^WorkingDirectory=\/var\/lib\/arisa-slave$/m);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/arisa\/src\/index\.js" slave --service-runner/);
  assert.match(unit, /StandardOutput=append:\/var\/lib\/arisa-slave\/state\/arisa-slave\.log/);
  assert.doesNotMatch(unit, /Telegram|Pi Agent/);
});

test("escapes systemd WorkingDirectory paths without quoting the entire value", () => {
  const unit = buildSlaveSystemdUnit({
    account: { scope: "user", user: "tester" },
    slaveHome: "/srv/arisa slave",
    entryFile: "/opt/arisa/src/index.js",
    nodePath: "/usr/bin/node"
  });
  assert.match(unit, /^WorkingDirectory=\/srv\/arisa\\x20slave$/m);
  assert.match(unit, /^StandardOutput=append:\/srv\/arisa\\x20slave\/state\/arisa-slave\.log$/m);
});

test("reports Master connectivity separately from pairing and daemon readiness", () => {
  const text = formatSlaveStatus({
    service: { running: true, status: "active", serviceManager: "launchd" },
    diagnostic: {
      daemon: { state: "ready" },
      role: "slave",
      endpoint: "tcp://198.51.100.12:4719",
      paired: true,
      network: { connected: false },
      toolCount: 1,
      jobs: { active: 0, queued: 0, failed: 0 },
      pendingSecrets: 0
    }
  });
  assert.match(text, /Service \(launchd\): active/);
  assert.match(text, /Daemon: ready/);
  assert.match(text, /Paired: yes/);
  assert.match(text, /Connected: no/);
});

test("refuses to replace the PID of an active Slave host", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "arisa-slave-pid-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = getSlavePaths(home);
  await registerSlaveServiceProcess(paths);
  assert.equal(await readFile(paths.pidFile, "utf8"), `${process.pid}\n`);
  await writeFile(paths.pidFile, `${process.ppid}\n`, { mode: 0o600 });
  await assert.rejects(() => registerSlaveServiceProcess(paths), /already running/);
});

test("installs and restarts the Linux systemd target after pairing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-slave-systemd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let accountExists = false;
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (command === "id" && args[0] === "-u" && !accountExists) throw new Error("missing user");
    if (command === "useradd") accountExists = true;
    if (command === "id" && args[0] === "-gn") return { stdout: "arisa-slave\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const result = await installSlaveSystemdService({
    account: { scope: "system", user: "arisa-slave", root: false, dedicated: true },
    slaveHome: path.join(root, "home"),
    entryFile: "/opt/arisa/src/index.js",
    execute,
    platform: "linux",
    systemUnitDir: path.join(root, "units")
  });
  assert.equal(result.account.root, false);
  assert.equal(await access(result.unitFile).then(() => true, () => false), true);
  assert.ok(calls.some(([command]) => command === "useradd"));
  assert.deepEqual(calls.filter(([command]) => command === "systemctl"), [
    ["systemctl", ["daemon-reload"]],
    ["systemctl", ["enable", "arisa-slave.service"]],
    ["systemctl", ["restart", "arisa-slave.service"]]
  ]);
});

test("builds and installs a macOS launchd service with isolated state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-slave-launchd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const account = { scope: "user", user: "tester", root: false, dedicated: false };
  const slaveHome = path.join(root, "home & state");
  const entryFile = "/Applications/Arisa & Tools/index.js";
  const plist = buildSlaveLaunchdPlist({
    account,
    slaveHome,
    entryFile,
    nodePath: "/opt/homebrew/bin/node",
    environment: { PATH: "/opt/homebrew/bin:/usr/bin" }
  });
  assert.match(plist, /<string>com\.arisa\.slave<\/string>/);
  assert.match(plist, /<string>\/Applications\/Arisa &amp; Tools\/index\.js<\/string>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n  <true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n  <true\/>/);

  const calls = [];
  const unitDir = path.join(root, "LaunchAgents");
  const result = await installSlaveLaunchdService({
    account,
    slaveHome,
    entryFile,
    execute: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === "bootout") throw new Error("not loaded");
      return { stdout: "", stderr: "" };
    },
    environment: { PATH: "/opt/homebrew/bin:/usr/bin" },
    platform: "darwin",
    uid: 501,
    userUnitDir: unitDir
  });
  assert.equal(result.serviceManager, "launchd");
  assert.equal(result.serviceTarget, "gui/501/com.arisa.slave");
  assert.equal(await access(result.unitFile).then(() => true, () => false), true);
  assert.deepEqual(calls.slice(1), [
    ["launchctl", ["bootstrap", "gui/501", result.unitFile]],
    ["launchctl", ["enable", "gui/501/com.arisa.slave"]],
    ["launchctl", ["kickstart", "-k", "gui/501/com.arisa.slave"]]
  ]);
});

test("controls a persisted macOS launchd service", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-slave-launchd-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = getSlavePaths(root);
  await mkdir(paths.state, { recursive: true });
  await writeFile(paths.descriptorFile, `${JSON.stringify({
    serviceManager: "launchd",
    serviceTarget: "gui/501/com.arisa.slave",
    unitFile: "/Users/tester/Library/LaunchAgents/com.arisa.slave.plist"
  })}\n`);
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, args]);
    return { stdout: "", stderr: "" };
  };
  const status = await controlSlaveService(paths, "status", { execute });
  assert.deepEqual(status, { running: true, status: "active", serviceManager: "launchd" });
  await controlSlaveService(paths, "restart", { execute });
  assert.deepEqual(calls, [
    ["launchctl", ["print", "gui/501/com.arisa.slave"]],
    ["launchctl", ["print", "gui/501/com.arisa.slave"]],
    ["launchctl", ["enable", "gui/501/com.arisa.slave"]],
    ["launchctl", ["kickstart", "-k", "gui/501/com.arisa.slave"]]
  ]);
});

test("builds, installs, and controls a Windows scheduled Slave task", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-slave-windows-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const account = { scope: "user", user: "MCL4SEN\\martin.clasen", root: false, dedicated: false };
  const entryFile = path.join(root, "Arisa & Tools", "index.js");
  const launcher = buildSlaveWindowsLauncher({
    slaveHome: path.join(root, "slave's home"),
    entryFile,
    nodePath: path.join(root, "Node", "node.exe")
  });
  assert.match(launcher, /process\.env\.ARISA_SLAVE_HOME/);
  assert.match(launcher, /slave's home/);
  assert.match(launcher, /"--service-runner"/);
  assert.match(launcher, /windowsHide: true/);
  assert.doesNotThrow(() => new Function(launcher));

  const taskXml = buildSlaveWindowsTaskXml({
    account,
    launcherFile: path.join(root, "arisa-slave-launcher.cjs"),
    nodePath: path.join(root, "Node", "node.exe")
  });
  assert.match(taskXml, /<UserId>MCL4SEN\\martin\.clasen<\/UserId>/);
  assert.match(taskXml, /<RestartOnFailure>/);
  assert.match(taskXml, /Node\/node\.exe/);
  assert.match(taskXml, /arisa-slave-launcher\.cjs/);
  assert.match(taskXml, /<WorkingDirectory>/);

  const calls = [];
  const result = await installSlaveWindowsService({
    account,
    slaveHome: path.join(root, "home"),
    entryFile,
    execute: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === "/End") throw new Error("not running");
      return { stdout: "", stderr: "" };
    },
    platform: "win32"
  });
  assert.equal(result.serviceManager, "windows-task");
  assert.equal(result.serviceTarget, "Arisa Slave");
  assert.equal(await access(result.launcherFile).then(() => true, () => false), true);
  assert.equal(await access(result.unitFile).then(() => true, () => false), true);
  const persistedLauncher = await readFile(result.launcherFile);
  assert.deepEqual([...persistedLauncher.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const persistedTask = await readFile(result.unitFile);
  assert.deepEqual([...persistedTask.subarray(0, 2)], [0xff, 0xfe]);
  assert.match(persistedTask.toString("utf16le"), /<Task version="1\.4"/);
  assert.deepEqual(calls.slice(1), [
    ["schtasks.exe", ["/Create", "/TN", "Arisa Slave", "/XML", result.unitFile, "/F"]],
    ["schtasks.exe", ["/Run", "/TN", "Arisa Slave"]]
  ]);

  const paths = result.paths;
  await writeFile(paths.descriptorFile, `${JSON.stringify({
    serviceManager: "windows-task",
    serviceTarget: "Arisa Slave",
    unitFile: result.unitFile,
    launcherFile: result.launcherFile
  })}\n`);
  await writeFile(paths.pidFile, `${process.pid}\n`);
  calls.length = 0;
  const status = await controlSlaveService(paths, "status", { execute: async (command, args) => {
    calls.push([command, args]);
    return { stdout: "", stderr: "" };
  } });
  assert.deepEqual(status, { running: true, status: "active", serviceManager: "windows-task" });
  assert.deepEqual(calls, [["schtasks.exe", ["/Query", "/TN", "Arisa Slave"]]]);
});

test("bootstraps macOS through launchd and persists its service identity", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "arisa-slave-macos-bootstrap-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = getSlavePaths(home);
  const account = { scope: "user", user: "tester", root: false, dedicated: false };
  const unitFile = "/Users/tester/Library/LaunchAgents/com.arisa.slave.plist";
  await runSlaveBootstrap(`tcp://198.51.100.12:4719/${secret}`, {
    paths,
    entryFile: "/opt/arisa/src/index.js",
    platform: "darwin",
    selectAccount: async () => account,
    ensureTool: async () => {},
    invokeTool: async () => ({ ok: true }),
    installService: async (options) => {
      assert.equal(options.platform, "darwin");
      return {
        serviceManager: "launchd",
        serviceTarget: "gui/501/com.arisa.slave",
        unitFile
      };
    },
    output: { log: () => {} }
  });
  const descriptor = JSON.parse(await readFile(paths.descriptorFile, "utf8"));
  assert.equal(descriptor.serviceManager, "launchd");
  assert.equal(descriptor.serviceTarget, "gui/501/com.arisa.slave");
  assert.equal(descriptor.unitFile, unitFile);
  assert.deepEqual(descriptor.account, account);
});

test("bootstraps Windows through Task Scheduler and persists its service identity", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "arisa-slave-windows-bootstrap-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = getSlavePaths(home);
  const account = { scope: "user", user: "MCL4SEN\\martin.clasen", root: false, dedicated: false };
  const launcherFile = path.join(home, "state", "arisa-slave-launcher.cjs");
  await runSlaveBootstrap(`tcp://198.51.100.12:4719/${secret}`, {
    paths,
    entryFile: "/opt/arisa/src/index.js",
    platform: "win32",
    selectAccount: async () => account,
    ensureTool: async () => {},
    invokeTool: async () => ({ ok: true }),
    installService: async (options) => {
      assert.equal(options.platform, "win32");
      return {
        serviceManager: "windows-task",
        serviceTarget: "Arisa Slave",
        unitFile: path.join(home, "state", "arisa-slave-task.xml"),
        launcherFile
      };
    },
    output: { log: () => {} }
  });
  const descriptor = JSON.parse(await readFile(paths.descriptorFile, "utf8"));
  assert.equal(descriptor.serviceManager, "windows-task");
  assert.equal(descriptor.serviceTarget, "Arisa Slave");
  assert.equal(descriptor.launcherFile, launcherFile);
});

test("validates before effects and keeps the bootstrap secret out of service metadata", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "arisa-slave-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = getSlavePaths(home);
  const calls = [];
  const result = await runSlaveBootstrap(`tcp://198.51.100.12:4719/${secret}`, {
    paths,
    entryFile: "/opt/arisa/src/index.js",
    platform: "linux",
    selectAccount: async (...args) => {
      assert.deepEqual(args, []);
      return { scope: "user", user: "tester", root: false, dedicated: false };
    },
    ensureTool: async () => { calls.push("tool"); },
    installService: async () => { calls.push("service"); },
    invokeTool: async (_paths, args) => {
      calls.push("invoke");
      assert.equal(args.action, "slave.bootstrap");
      assert.equal((await stat(args.bootstrapFile)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(args.bootstrapFile, "utf8")), {
        url: `tcp://198.51.100.12:4719/${secret}`
      });
      return { ok: true };
    },
    output: { log: () => {} }
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ["tool", "invoke", "service"]);
  const descriptor = await readFile(paths.descriptorFile, "utf8");
  const config = await readFile(paths.configFile, "utf8");
  assert.doesNotMatch(descriptor, /arisa_secret/);
  assert.doesNotMatch(config, /arisa_secret/);

  calls.length = 0;
  await assert.rejects(
    () => runSlaveBootstrap("tcp://hostname:4719/invalid", {
      paths,
      platform: "linux",
      selectAccount: async () => { calls.push("account"); }
    })
  );
  assert.deepEqual(calls, []);
});

test("explains an incomplete Master pairing handshake", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "arisa-slave-handshake-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(
    () => runSlaveBootstrap(`tcp://198.51.100.12:4719/${secret}`, {
      paths: getSlavePaths(home),
      entryFile: "/opt/arisa/src/index.js",
      platform: "linux",
      selectAccount: async () => ({ scope: "user", user: "tester", root: false, dedicated: false }),
      ensureTool: async () => {},
      installService: async () => assert.fail("service must not be installed after a failed handshake"),
      invokeTool: async () => {
        throw new Error("Socket closed before the protocol completed");
      },
      output: { log: () => {} }
    }),
    /bootstrap URL may be expired, rotated, already used, or invalid.*before it expires/i
  );
});

test("ships an immutable verified master-slave bootstrap lock", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "arisa-slave-lock-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const result = await ensureMasterSlaveTool(getSlavePaths(home), {
    install: async (request) => {
      calls.push(request);
      return { commit: request.lock.commit };
    }
  });
  assert.equal(result.installed, true);
  assert.match(result.commit, /^[a-f0-9]{40}$/);
  assert.equal(calls[0].toolName, "master-slave");
  assert.ok(Object.keys(calls[0].lock.tools["master-slave"].files).length > 0);
});

test("starts the headless composition without Telegram or Pi components", async () => {
  const calls = [];
  const toolRegistry = {
    load: async () => { calls.push("tools.load"); },
    list: () => [],
    run: async () => ({ ok: true })
  };
  const taskStore = {
    recoverInterrupted: async () => { calls.push("tasks.recover"); },
    addMany: async () => []
  };
  const supervisor = {
    start: async () => { calls.push("supervisor.start"); },
    stop: async () => { calls.push("supervisor.stop"); }
  };
  const ipcServer = {
    socketPath: "/isolated/slave.sock",
    start: async () => { calls.push("ipc.start"); },
    stop: async () => { calls.push("ipc.stop"); }
  };
  const app = await createHeadlessApp({
    configLoader: async () => ({ daemons: { supervisorIntervalMs: 1 } }),
    artifactStoreFactory: () => ({ forChat: () => ({}) }),
    taskStoreFactory: () => taskStore,
    toolRegistryFactory: () => toolRegistry,
    supervisorFactory: () => supervisor,
    capabilitiesFactory: ({ agentManager }) => {
      assert.equal(typeof agentManager.runTool, "function");
      calls.push("capabilities.create");
      return { dispatch: async () => ({}) };
    },
    ipcServerFactory: () => ipcServer
  });
  await app.start();
  await app.stop();
  assert.deepEqual(calls, [
    "tools.load",
    "capabilities.create",
    "ipc.start",
    "tasks.recover",
    "supervisor.start",
    "supervisor.stop",
    "ipc.stop"
  ]);
});

test("combines systemd and local tool diagnostics for Slave status", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "arisa-slave-status-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const output = [];
  const result = await runSlaveCli({
    positionals: ["status"],
    paths: getSlavePaths(home),
    controlService: async (_paths, operation) => {
      assert.equal(operation, "status");
      return { running: true, status: "active", serviceManager: "systemd" };
    },
    toolInstalled: async () => true,
    invokeTool: async (_paths, args) => {
      assert.deepEqual(args, { action: "slave.status" });
      return {
        ok: true,
        output: {
          json: {
            daemon: { state: "ready" },
            role: "slave",
            endpoint: "tcp://198.51.100.12:4719",
            identityFingerprint: "abcd1234",
            paired: true,
            toolCount: 4,
            jobs: { active: 1, queued: 2, failed: 0 },
            pendingSecrets: 0
          }
        }
      };
    },
    output: { log: (line) => output.push(line) }
  });
  assert.equal(result.service.running, true);
  assert.match(output[0], /Service \(systemd\): active/);
  assert.match(output[0], /Daemon: ready/);
  assert.match(output[0], /Role: slave/);
  assert.match(output[0], /Endpoint: tcp:\/\/198\.51\.100\.12:4719/);
  assert.match(output[0], /Identity: abcd1234/);
  assert.match(output[0], /Paired: yes/);
  assert.match(output[0], /Tools: 4/);
  assert.match(output[0], /Jobs: active=1, queued=2, failed=0/);
  assert.match(output[0], /Pending secrets: 0/);
});

test("prints Slave help without touching service or Master bootstrap state", async () => {
  const output = [];
  const result = await runSlaveCli({
    flags: { help: true },
    output: { log: (line) => output.push(line) },
    controlService: async () => assert.fail("service must not be inspected for help")
  });
  assert.deepEqual(result, { help: true });
  assert.match(output[0], /^Usage: arisa slave/);
});
