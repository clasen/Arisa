import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArisaClient } from "../src/core/tools/ipc-client.js";
import { createArisaCapabilities } from "../src/runtime/arisa-capabilities.js";
import { createIpcServer } from "../src/runtime/ipc/ipc-server.js";

function createFakeArtifactStore() {
  const stores = new Map();
  return {
    forChat(chatId) {
      const key = String(chatId);
      if (!stores.has(key)) {
        const items = [];
        stores.set(key, {
          createText: async ({ text, source, metadata }) => {
            const artifact = { id: `artifact-${items.length + 1}`, chatId: key, text, source, metadata };
            items.push(artifact);
            return artifact;
          },
          listRecent: async () => [...items].reverse(),
          get: async (artifactId) => items.find((item) => item.id === artifactId) || null
        });
      }
      return stores.get(key);
    }
  };
}

function createFakeTaskStore() {
  const tasks = [];
  return {
    add: async (task, defaults = {}) => {
      const created = {
        id: `task-${tasks.length + 1}`,
        ...task,
        payload: { ...(defaults.payload || {}), ...(task.payload || {}) },
        source: { ...(defaults.source || {}), ...(task.source || {}) }
      };
      tasks.push(created);
      return created;
    },
    list: async (filter = {}) => tasks.filter((task) => {
      if (filter.chatId && String(task.payload?.chatId) !== String(filter.chatId)) return false;
      if (filter.kind && task.kind !== filter.kind) return false;
      if (filter.status && task.status !== filter.status) return false;
      return true;
    }),
    get: async (taskId) => tasks.find((task) => task.id === taskId) || null,
    cancel: async (taskId) => {
      const index = tasks.findIndex((task) => task.id === taskId);
      if (index === -1) return null;
      const [removed] = tasks.splice(index, 1);
      return removed;
    }
  };
}

function createCapabilities() {
  return createArisaCapabilities({
    artifactStore: createFakeArtifactStore(),
    taskStore: createFakeTaskStore()
  });
}

async function createTempSocketPath() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-ipc-"));
  return path.join(root, "arisa.sock");
}

async function sendRaw(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newlineIndex)));
    });
    socket.once("error", reject);
  });
}

test("dispatches explicit capabilities over local IPC", async () => {
  const socketPath = await createTempSocketPath();
  const ipcServer = createIpcServer({ capabilities: createCapabilities(), socketPath });
  await ipcServer.start();

  try {
    const client = createArisaClient({ toolName: "ipc-tool", chatId: 123, socketPath });
    const artifact = await client.artifacts.createText({ text: "hello" });
    assert.equal(artifact.text, "hello");
    assert.equal(artifact.source.toolName, "ipc-tool");
    assert.equal(artifact.source.chatId, 123);
  } finally {
    await ipcServer.stop();
  }
});

test("rejects unknown IPC methods", async () => {
  const socketPath = await createTempSocketPath();
  const ipcServer = createIpcServer({ capabilities: createCapabilities(), socketPath });
  await ipcServer.start();

  try {
    const response = await sendRaw(socketPath, {
      id: "one",
      method: "unknown.method",
      toolName: "ipc-tool",
      params: {}
    });
    assert.equal(response.ok, false);
    assert.match(response.error, /unknown IPC method/);
  } finally {
    await ipcServer.stop();
  }
});

test("requires chatId for chat-scoped capabilities", async () => {
  const socketPath = await createTempSocketPath();
  const ipcServer = createIpcServer({ capabilities: createCapabilities(), socketPath });
  await ipcServer.start();

  try {
    const client = createArisaClient({ toolName: "ipc-tool", socketPath });
    await assert.rejects(
      () => client.artifacts.listRecent(),
      /artifacts\.listRecent requires chatId/
    );
  } finally {
    await ipcServer.stop();
  }
});

test("listens on a local socket, not a TCP port", async () => {
  const socketPath = await createTempSocketPath();
  const ipcServer = createIpcServer({ capabilities: createCapabilities(), socketPath });
  await ipcServer.start();

  try {
    assert.equal(ipcServer.address(), socketPath);
  } finally {
    await ipcServer.stop();
  }
});
