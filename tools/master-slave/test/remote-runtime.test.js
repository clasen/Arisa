import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bootstrapSlaveConnection,
  createPairingStore,
  createRuntimeIdentity,
  MasterNetworkRuntime,
  notifySlavePairing,
  resolveSlavePolicy,
  SlaveNetworkRuntime
} from "../remote-runtime.js";
import { MasterSlaveStateStore } from "../state-store.js";

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Master/Slave state");
}

async function within(label, work, timeoutMs = 3_000) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out during ${label}`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function job(slaveId, operation, args) {
  const now = Date.now();
  return {
    jobId: `${operation}-${now}-${Math.random()}`,
    batchId: `batch-${now}`,
    slaveId,
    operation,
    args,
    requestedByChatId: "123",
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10_000).toISOString(),
    scope: "test"
  };
}

test("defaults an unconfigured root Slave to unrestricted remote capabilities", () => {
  const config = { roots: [], capabilities: [], fullHost: false };

  assert.deepEqual(resolveSlavePolicy({ config, root: true }), {
    roots: ["/"],
    capabilities: ["inspect", "read", "tool.run", "tool.install", "exec"],
    fullHost: true
  });
  assert.deepEqual(resolveSlavePolicy({ config, root: false }), config);
});

test("keeps an explicit root Slave policy instead of restoring unrestricted defaults", () => {
  const policy = { roots: ["/srv/storybot"], capabilities: ["inspect"], fullHost: false };

  assert.deepEqual(resolveSlavePolicy({
    policy,
    config: { roots: [], capabilities: [], fullHost: false },
    root: true
  }), policy);
});

test("notifies authorized chats after pairing but stays silent on reconnect", async () => {
  const notifications = [];
  const clientForChat = (chatId) => ({
    agent: {
      enqueueEvent: async (event) => notifications.push({ chatId, event })
    }
  });
  const peer = {
    slaveId: "slave-notification",
    authorizedChatIds: ["123", "456"],
    profile: { name: "build-host" }
  };

  assert.equal(await notifySlavePairing({ type: "connected", peer, paired: false }, clientForChat), false);
  assert.deepEqual(notifications, []);
  assert.equal(await notifySlavePairing({ type: "connected", peer, paired: true }, clientForChat), true);
  assert.deepEqual(notifications.map(({ chatId }) => chatId), ["123", "456"]);
  assert.ok(notifications.every(({ event }) => event.resourceId === peer.slaveId));
  assert.match(notifications[0].event.prompt, /finished pairing.*Notify the user now.*added successfully and is online/i);
});

test("pairs, reconnects, authorizes, configures, reads, deduplicates, and revokes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-master-slave-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const readable = path.join(root, "readable");
  const artifactFile = path.join(root, "large-artifact.bin");
  const artifactContent = Buffer.alloc(800_000, 0x5a);
  await writeFile(readable, "hello", "utf8");
  await writeFile(artifactFile, artifactContent);
  const masterState = new MasterSlaveStateStore(path.join(root, "master"));
  const slaveState = new MasterSlaveStateStore(path.join(root, "slave"));
  const connectionEvents = [];
  const port = await reservePort();
  const config = {
    listenHost: "127.0.0.1",
    listenPort: port,
    publicEndpoint: `tcp://127.0.0.1:${port}`,
    bootstrapSecretTtlMs: 600_000,
    maxFrameBytes: 1_048_576,
    maxJobOutputBytes: 16_777_216,
    maxReadBytes: 1_048_576,
    maxDirectoryEntries: 100,
    maxProcessTimeoutMs: 5_000,
    reconnectMinMs: 10,
    reconnectMaxMs: 20,
    roots: [],
    capabilities: []
  };
  const master = new MasterNetworkRuntime({
    config,
    state: masterState,
    identity: await createRuntimeIdentity(masterState),
    pairingStore: createPairingStore(masterState, config),
    onConnectionEvent: async (event) => connectionEvents.push(event)
  });
  await master.start();
  t.after(() => master.stop());
  const bootstrap = await master.createBootstrap("123");
  const slaveIdentity = await createRuntimeIdentity(slaveState);
  const paired = await within("initial pairing", bootstrapSlaveConnection({
    url: bootstrap.url,
    state: slaveState,
    identity: slaveIdentity,
    profile: {
      slaveId: "",
      name: "runtime-test",
      hostname: "runtime-test",
      platform: process.platform,
      arch: process.arch,
      arisaVersion: "test",
      privilege: { user: "test", root: false, scope: "restricted" },
      roots: [],
      capabilities: [],
      tools: []
    },
    maxFrameBytes: config.maxFrameBytes
  }));
  await waitFor(() => connectionEvents.find((event) => event.type === "connected" && event.paired === true));
  paired.connection.close();
  const ipcChatIds = [];
  const slave = new SlaveNetworkRuntime({
    config,
    state: slaveState,
    identity: slaveIdentity,
    arisaVersion: "test",
    arisa: (chatId) => {
      ipcChatIds.push(String(chatId));
      return {
        artifacts: { get: async () => ({ path: artifactFile, name: "result.bin" }) },
        tools: {
          installOfficial: async ({ name }) => ({ toolName: name, installed: true }),
          list: async () => ({ tools: [] }),
          run: async () => ({ ok: true, output: { artifactId: "artifact-1", mimeType: "application/octet-stream" } })
        }
      };
    }
  });
  slave.start().catch(() => {});
  t.after(() => slave.stop());
  const peer = await waitFor(async () => {
    const current = await masterState.listPeers().then((peers) => peers[0]);
    return current?.connectionState === "connected" && master.connections.has(current.slaveId) ? current : null;
  });
  assert.equal(connectionEvents.filter((event) => event.type === "connected" && event.paired === true).length, 1);
  assert.ok(connectionEvents.some((event) => event.type === "connected" && event.paired === false));
  assert.equal(slave.diagnostic().running, true);
  assert.equal(slave.diagnostic().connected, true);
  assert.equal(slave.diagnostic().lastConnectionError, null);

  const configured = await within("configure job", master.run(job(peer.slaveId, "slave.configure", {
    name: "configured",
    description: "test",
    roots: [root],
    capabilities: ["inspect", "read", "tool.run", "tool.install"],
    fullHost: false
  })));
  assert.deepEqual(configured.roots, [root]);

  const readJob = job(peer.slaveId, "fs.read", { path: readable });
  const first = await within("read job", master.run(readJob));
  assert.equal(Buffer.from(first.remoteArtifact.contentBase64, "base64").toString("utf8"), "hello");
  const repeated = await within("repeated read job", master.run(readJob));
  assert.deepEqual(repeated, first);

  const toolResult = await within("tool artifact job", master.run(job(peer.slaveId, "tool.run", {
    tool: "fixture",
    args: {}
  })));
  assert.equal(toolResult.output.remoteArtifact.fileName, "result.bin");
  assert.deepEqual(Buffer.from(toolResult.output.remoteArtifact.contentBase64, "base64"), artifactContent);
  assert.deepEqual(ipcChatIds.filter((chatId) => chatId !== "null"), ["123"]);

  const installed = await within("official tool install job", master.run(job(peer.slaveId, "tool.install", {
    tool: "fixture",
    confirmToolName: "fixture",
    confirmRoot: peer.slaveId
  })));
  assert.deepEqual(installed, { toolName: "fixture", installed: true });

  await assert.rejects(
    () => master.run({ ...job(peer.slaveId, "fs.read", { path: readable }), requestedByChatId: "999" }),
    (error) => error.code === "NOT_AUTHORIZED"
  );

  await master.revoke(peer.slaveId);
  await waitFor(async () => (await slaveState.readSlave())?.paired === false);
  assert.equal((await masterState.getPeer(peer.slaveId)).revoked, true);
});

test("Slave diagnostics retain a bounded reconnect failure", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arisa-slave-diagnostic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new MasterSlaveStateStore(directory);
  const port = await reservePort();
  await state.writeSlave({
    slaveId: "diagnostic-slave",
    paired: true,
    endpoint: `tcp://127.0.0.1:${port}`,
    masterIdentityPublicKey: Buffer.alloc(32).toString("base64")
  });
  const runtime = new SlaveNetworkRuntime({
    config: {
      maxFrameBytes: 1_048_576,
      maxJobOutputBytes: 1_048_576,
      maxProcessTimeoutMs: 1_000,
      reconnectMinMs: 5,
      reconnectMaxMs: 10,
      roots: [],
      capabilities: []
    },
    state,
    identity: await createRuntimeIdentity(state),
    arisa: () => ({ tools: { list: async () => [] } }),
    arisaVersion: "test"
  });
  runtime.start().catch(() => {});
  t.after(() => runtime.stop());

  const diagnostic = await waitFor(() => runtime.diagnostic().lastConnectionError && runtime.diagnostic());
  assert.equal(diagnostic.running, true);
  assert.equal(diagnostic.connected, false);
  assert.match(diagnostic.lastConnectionError.message, /ECONNREFUSED/);
  assert.ok(diagnostic.lastConnectionError.message.length <= 500);
});
