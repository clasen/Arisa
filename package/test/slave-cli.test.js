import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHeadlessApp } from "../src/runtime/create-headless-app.js";
import { parseSlaveBootstrapUrl } from "../src/runtime/slave-bootstrap-url.js";
import { withSecureRequestFile } from "../src/runtime/secure-request-file.js";
import { ensureMasterSlaveTool, runSlaveBootstrap, runSlaveCli } from "../src/runtime/slave-cli.js";
import {
  buildSlaveSystemdUnit,
  getSlavePaths,
  installSlaveSystemdService,
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

test("never selects root without an explicit second confirmation", async () => {
  await assert.rejects(() => selectSlaveServiceAccount({ euid: 0 }), /explicit account selection/);
  const rejectedAnswers = ["3", "yes"];
  await assert.rejects(
    () => selectSlaveServiceAccount({ euid: 0, ask: async () => rejectedAnswers.shift() }),
    /Root execution was not confirmed/
  );
  const acceptedAnswers = ["3", "RUN AS ROOT"];
  assert.deepEqual(
    await selectSlaveServiceAccount({ euid: 0, ask: async () => acceptedAnswers.shift() }),
    { scope: "system", user: "root", root: true, dedicated: false }
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
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/arisa\/src\/index\.js" slave --service-runner/);
  assert.match(unit, /StandardOutput=append:\/var\/lib\/arisa-slave\/state\/arisa-slave\.log/);
  assert.doesNotMatch(unit, /Telegram|Pi Agent/);
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

test("installs the dedicated Linux systemd target without silently selecting root", async (t) => {
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
  assert.ok(calls.some(([command, args]) => command === "systemctl" && args.includes("enable") && args.includes("--now")));
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
    selectAccount: async () => ({ scope: "user", user: "tester", root: false, dedicated: false }),
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
      return { running: true, status: "active" };
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
  assert.equal(result.systemd.running, true);
  assert.match(output[0], /Systemd: active/);
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
