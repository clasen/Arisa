import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { createBootstrapSecret } from "../lib/bootstrap-url.js";
import { generateIdentity } from "../lib/handshake-crypto.js";
import {
  acceptMasterHandshake,
  connectSlaveHandshake,
  MESSAGE_TYPES
} from "../network-session.js";

const maxFrameBytes = 1_048_576;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address();
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("pairs once, binds the chat, and exchanges encrypted bidirectional messages", async (t) => {
  const masterIdentity = generateIdentity();
  const slaveIdentity = generateIdentity();
  const secret = createBootstrapSecret();
  let consumed = 0;
  let peer = null;
  const server = net.createServer();
  t.after(() => closeServer(server));
  const address = await listen(server);
  const accepted = new Promise((resolve, reject) => {
    server.once("connection", (socket) => acceptMasterHandshake(socket, {
      identity: masterIdentity,
      pairing: {
        claim: async (secretId) => {
          assert.equal(secretId, "pending-secret");
          return {
            secret,
            chatId: "123",
            consume: async () => { consumed += 1; }
          };
        }
      },
      resolvePeer: async () => null,
      persistPeer: async (record) => {
        peer = record;
        return record;
      },
      maxFrameBytes
    }).then(resolve, reject));
  });

  const socket = net.createConnection(address.port, "127.0.0.1");
  const connected = await connectSlaveHandshake(socket, {
    identity: slaveIdentity,
    slaveId: "slave-1",
    profile: { name: "test-slave", capabilities: ["inspect"] },
    secret,
    secretId: "pending-secret",
    maxFrameBytes
  });
  const master = await accepted;
  assert.equal(consumed, 1);
  assert.deepEqual(peer.authorizedChatIds, ["123"]);
  assert.equal(connected.acknowledgement.authorizedChatIds[0], "123");

  await connected.connection.send(MESSAGE_TYPES.HEARTBEAT, { direction: "slave-master" });
  assert.deepEqual((await master.connection.receive()).payload, { direction: "slave-master" });
  await master.connection.send(MESSAGE_TYPES.PROFILE, { direction: "master-slave" });
  assert.deepEqual((await connected.connection.receive()).payload, { direction: "master-slave" });
  connected.connection.close();
});

test("reconnects with persistent identities and fresh ephemeral session keys", async (t) => {
  const masterIdentity = generateIdentity();
  const slaveIdentity = generateIdentity();
  const existingPeer = {
    slaveId: "slave-reconnect",
    identityPublicKey: slaveIdentity.publicKey,
    authorizedChatIds: ["123"]
  };
  const server = net.createServer();
  t.after(() => closeServer(server));
  const address = await listen(server);
  const accepted = new Promise((resolve, reject) => {
    server.once("connection", (socket) => acceptMasterHandshake(socket, {
      identity: masterIdentity,
      pairing: { claim: async () => { throw new Error("pairing should not be used"); } },
      resolvePeer: async (slaveId) => slaveId === existingPeer.slaveId ? existingPeer : null,
      persistPeer: async (record) => record,
      maxFrameBytes
    }).then(resolve, reject));
  });
  const socket = net.createConnection(address.port, "127.0.0.1");
  const connected = await connectSlaveHandshake(socket, {
    identity: slaveIdentity,
    slaveId: existingPeer.slaveId,
    profile: { name: "test-slave", capabilities: ["inspect"] },
    expectedMasterPublicKey: masterIdentity.publicKey,
    maxFrameBytes
  });
  const master = await accepted;
  assert.equal(connected.paired, false);
  assert.equal(master.paired, false);
  connected.connection.close();
});

test("rejects a changed Master identity before persisting an endpoint update", async (t) => {
  const slaveIdentity = generateIdentity();
  const server = net.createServer();
  t.after(() => closeServer(server));
  const address = await listen(server);
  server.once("connection", (socket) => acceptMasterHandshake(socket, {
    identity: generateIdentity(),
    pairing: { claim: async () => null },
    resolvePeer: async () => ({
      slaveId: "slave-changed-master",
      identityPublicKey: slaveIdentity.publicKey,
      authorizedChatIds: ["123"]
    }),
    persistPeer: async (record) => record,
    maxFrameBytes
  }).catch(() => {}));
  const socket = net.createConnection(address.port, "127.0.0.1");
  await assert.rejects(
    () => connectSlaveHandshake(socket, {
      identity: slaveIdentity,
      slaveId: "slave-changed-master",
      profile: {},
      expectedMasterPublicKey: generateIdentity().publicKey,
      maxFrameBytes
    }),
    /Master identity fingerprint changed/
  );
});
