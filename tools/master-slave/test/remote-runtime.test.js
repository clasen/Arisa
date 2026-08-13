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
    pairingStore: createPairingStore(masterState, config)
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
          list: async () => [],
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
