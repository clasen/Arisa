import assert from "node:assert/strict";
import test from "node:test";
import { createArisaCapabilities } from "../src/runtime/arisa-capabilities.js";
import { createCapabilityService } from "../src/core/capabilities/capability-service.js";

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
    "artifacts.deliver",
    "tasks.add",
    "tasks.list",
    "tasks.cancel",
    "tasks.cancelAll",
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

test("tool-emitted tasks cannot override trusted chat routing", async () => {
  const capabilities = createCapabilities();
  const created = await capabilities.dispatch({
    method: "tasks.add",
    toolName: "poller",
    chatId: "trusted-chat",
    params: {
      task: {
        kind: "agent_task",
        route: { transport: "telegram", destination: { chatId: "attacker-chat" } },
        payload: {
          chatId: "attacker-chat",
          telegramContext: { transportChatId: "attacker-chat" },
          prompt: "Safe payload"
        }
      }
    }
  });

  assert.equal(created.route, undefined);
  assert.equal(created.payload.chatId, "trusted-chat");
  assert.equal(created.payload.telegramContext, undefined);
  assert.equal(created.payload.prompt, "Safe payload");
});

test("IPC resource notes remain scoped to the calling tool", async () => {
  const calls = [];
  const capabilities = createArisaCapabilities({
    artifactStore: createFakeArtifactStore(),
    taskStore: createFakeTaskStore(),
    resourceNotes: {
      set: async (...args) => {
        calls.push(args);
        return { ok: true };
      }
    }
  });

  await capabilities.dispatch({
    method: "tools.setResourceNote",
    toolName: "caller-tool",
    chatId: "chat-1",
    params: { name: "other-tool", resourceId: "resource-1", note: "watch" }
  });

  assert.deepEqual(calls, [["chat-1", "caller-tool", "resource-1", "watch"]]);
});

test("IPC does not expose Telegram-only capability methods", async () => {
  const capabilities = createCapabilities();
  await assert.rejects(() => capabilities.dispatch({
    method: "telegram.createTopic",
    toolName: "caller-tool",
    chatId: "chat-1",
    params: { name: "Unsafe", context: "No" }
  }), /unknown IPC method: telegram\.createTopic/);
});

test("agent events preserve a bounded immediate acknowledgement", async () => {
  const capabilities = createCapabilities();
  const created = await capabilities.dispatch({
    method: "agent.enqueueEvent",
    toolName: "browser-session-bridge",
    chatId: "chat-a",
    params: {
      prompt: "Continue the pending authorization flow",
      acknowledgement: "Authorization received. Continuing now."
    }
  });

  assert.equal(created.payload.acknowledgement, "Authorization received. Continuing now.");
  await assert.rejects(() => capabilities.dispatch({
    method: "agent.enqueueEvent",
    toolName: "browser-session-bridge",
    chatId: "chat-a",
    params: { prompt: "Continue", acknowledgement: "x".repeat(501) }
  }), /at most 500 characters/);
});

test("delivers only artifacts resolved from the requesting chat", async () => {
  const artifact = { id: "artifact-1", chatId: "chat-a", path: "/safe/chat-a/file.txt" };
  const deliveries = [];
  const capabilities = createCapabilities({
    artifactStore: {
      forChat: (chatId) => ({
        get: async (artifactId) => String(chatId) === "chat-a" && artifactId === artifact.id ? artifact : null
      })
    },
    agentManager: {
      deliverArtifact: async (payload) => {
        deliveries.push(payload);
        return { ok: true };
      }
    }
  });

  await assert.rejects(() => capabilities.dispatch({
    method: "artifacts.deliver",
    toolName: "ipc-tool",
    chatId: "chat-b",
    params: { artifactId: "artifact-1", path: artifact.path }
  }), /Artifact not found/);
  assert.equal(deliveries.length, 0);

  await capabilities.dispatch({
    method: "artifacts.deliver",
    toolName: "ipc-tool",
    chatId: "chat-a",
    params: { artifactId: "artifact-1", path: "/attacker/chosen/path" }
  });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].artifact.path, artifact.path);
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

test("records blocked authentication and stops later tools inside an agent task", async () => {
  const execution = { blockedAuth: null };
  const resolution = { retryAfterSeconds: 3600, probeArgs: { action: "status" } };
  let executions = 0;
  const service = createCapabilityService({
    artifactStore: createFakeArtifactStore(),
    toolRegistry: { async load() {} },
    toolExecutor: {
      async runTool() {
        executions += 1;
        return { ok: false, status: "blocked_auth", error: "authentication expired", resolution };
      }
    }
  });
  const run = (name) => service.execute({
    method: "tools.run",
    actorToolName: "run_tool",
    chatId: "chat-1",
    params: { name, args: {} },
    context: { agentTaskExecution: execution }
  });

  await run("creator-scout");
  assert.deepEqual(execution.blockedAuth, {
    toolName: "creator-scout",
    error: "authentication expired",
    resolution
  });

  const skipped = await run("campaign-draft-runner");
  assert.equal(skipped.status, "blocked_prerequisite");
  assert.equal(skipped.resolution.prerequisiteStatus, "blocked_auth");
  assert.equal(executions, 1);
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

test("requires exact confirmation before installing a bundled official tool", async () => {
  const calls = [];
  const toolRegistry = { load: async () => calls.push("reload") };
  const capabilities = createArisaCapabilities({
    artifactStore: createFakeArtifactStore(),
    taskStore: createFakeTaskStore(),
    toolRegistry,
    installOfficialTool: async (name) => {
      calls.push(name);
      return { toolName: name, installed: true };
    }
  });

  await assert.rejects(() => capabilities.dispatch({
    method: "tools.installOfficial",
    toolName: "master-slave",
    params: { name: "fixture", confirmName: "other" }
  }), /confirmName equal to name/);
  assert.deepEqual(calls, []);

  const result = await capabilities.dispatch({
    method: "tools.installOfficial",
    toolName: "master-slave",
    params: { name: "fixture", confirmName: "fixture" }
  });
  assert.deepEqual(result, { toolName: "fixture", installed: true });
  assert.deepEqual(calls, ["fixture", "reload"]);
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
