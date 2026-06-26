import assert from "node:assert/strict";
import test from "node:test";
import { createArisaCapabilities } from "../src/runtime/arisa-capabilities.js";

function createFakeArtifactStore() {
  const stores = new Map();
  return {
    forChat(chatId) {
      const key = String(chatId);
      if (!stores.has(key)) {
        const items = [];
        stores.set(key, {
          createText: async ({ text, mimeType, source, metadata }) => {
            const artifact = {
              id: `artifact-${items.length + 1}`,
              chatId: key,
              kind: "text",
              mimeType,
              text,
              source,
              metadata
            };
            items.push(artifact);
            return artifact;
          },
          listRecent: async (limit) => [...items].slice(-limit).reverse(),
          get: async (artifactId) => items.find((item) => item.id === artifactId) || null
        });
      }
      return stores.get(key);
    }
  };
}

function createFakeTaskStore(initialTasks = []) {
  const tasks = [...initialTasks];
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
      if (filter.chatId && task.payload?.chatId !== filter.chatId) return false;
      if (filter.status && task.status !== filter.status) return false;
      if (filter.kind && task.kind !== filter.kind) return false;
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

function createCapabilities(overrides = {}) {
  return createArisaCapabilities({
    artifactStore: overrides.artifactStore || createFakeArtifactStore(),
    taskStore: overrides.taskStore || createFakeTaskStore(),
    agentManager: overrides.agentManager
  });
}

test("rejects cancellation of tasks from another chat", async () => {
  const capabilities = createCapabilities({
    taskStore: createFakeTaskStore([
      { id: "task-1", status: "pending", payload: { chatId: "chat-a" } }
    ])
  });

  await assert.rejects(
    () => capabilities.dispatch({
      method: "tasks.cancel",
      toolName: "poller",
      chatId: "chat-b",
      params: { taskId: "task-1" }
    }),
    /task does not belong to chatId/
  );
});

test("requires a non-empty toolName for all IPC dispatches", async () => {
  const capabilities = createCapabilities();

  await assert.rejects(
    () => capabilities.dispatch({
      method: "paths.getToolStateDir",
      toolName: "  ",
      params: {}
    }),
    /toolName is required/
  );

  await assert.rejects(
    () => capabilities.dispatch({
      method: "paths.getToolStateDir",
      toolName: null,
      params: {}
    }),
    /toolName is required/
  );
});

test("requires chatId for chat-scoped IPC methods", async () => {
  const capabilities = createCapabilities({
    agentManager: {
      runTool: async () => ({ ok: true, status: "ok" })
    }
  });

  for (const method of [
    "artifacts.createText",
    "artifacts.listRecent",
    "artifacts.get",
    "tasks.add",
    "tasks.list",
    "tasks.cancel",
    "agent.enqueueEvent",
    "paths.getChatToolStateDir",
    "paths.getChatToolTmpDir",
    "paths.getChatArtifactsDir",
    "tools.run"
  ]) {
    await assert.rejects(
      () => capabilities.dispatch({
        method,
        toolName: "ipc-tool",
        params: method === "tasks.cancel" ? { taskId: "task-1" } : {}
      }),
      new RegExp(`${method.replace(".", "\\.")} requires chatId`)
    );
  }
});

test("normalizes tool run args and rejects arrays", async () => {
  const calls = [];
  const capabilities = createCapabilities({
    agentManager: {
      runTool: async (request) => {
        calls.push(request);
        return { ok: true, status: "ok" };
      }
    }
  });

  await capabilities.dispatch({
    method: "tools.run",
    toolName: "caller",
    chatId: "chat-1",
    params: { name: "worker", args: null }
  });
  assert.deepEqual(calls.at(-1).request.args, {});

  await capabilities.dispatch({
    method: "tools.run",
    toolName: "caller",
    chatId: "chat-1",
    params: { name: "worker", args: { bpm: 128 } }
  });
  assert.deepEqual(calls.at(-1).request.args, { bpm: 128 });

  await assert.rejects(
    () => capabilities.dispatch({
      method: "tools.run",
      toolName: "caller",
      chatId: "chat-1",
      params: { name: "worker", args: ["not", "an", "object"] }
    }),
    /args must be an object/
  );
});

test("rejects missing artifact input before running a tool", async () => {
  const calls = [];
  const capabilities = createCapabilities({
    agentManager: {
      runTool: async (request) => {
        calls.push(request);
        return { ok: true, status: "ok" };
      }
    }
  });

  await assert.rejects(
    () => capabilities.dispatch({
      method: "tools.run",
      toolName: "caller",
      chatId: "chat-1",
      params: { name: "worker", artifactId: "missing" }
    }),
    /Artifact not found: missing/
  );
  assert.equal(calls.length, 0);
});

test("normalizes list limits for artifact reads", async () => {
  const observedLimits = [];
  const artifactStore = {
    forChat: () => ({
      listRecent: async (limit) => {
        observedLimits.push(limit);
        return [];
      }
    })
  };
  const capabilities = createCapabilities({ artifactStore });

  await capabilities.dispatch({
    method: "artifacts.listRecent",
    toolName: "viewer",
    chatId: "chat-1",
    params: { limit: 0 }
  });
  await capabilities.dispatch({
    method: "artifacts.listRecent",
    toolName: "viewer",
    chatId: "chat-1",
    params: { limit: "not-a-number" }
  });
  await capabilities.dispatch({
    method: "artifacts.listRecent",
    toolName: "viewer",
    chatId: "chat-1",
    params: { limit: 1000 }
  });

  assert.deepEqual(observedLimits, [20, 20, 100]);
});

test("rejects unknown IPC methods", async () => {
  const capabilities = createCapabilities();

  await assert.rejects(
    () => capabilities.dispatch({
      method: "unknown.method",
      toolName: "caller",
      params: {}
    }),
    /unknown IPC method: unknown\.method/
  );
});
