import assert from "node:assert/strict";
import test from "node:test";
import { taskWithoutCallerRouting } from "../src/core/tasks/task-routing.js";
import { materializeToolOutput } from "../src/core/tools/tool-output-materializer.js";

test("external tasks cannot override owner scope or transport routing", () => {
  assert.deepEqual(taskWithoutCallerRouting({
    kind: "agent_task",
    route: { transport: "telegram", destination: { chatId: -999, threadId: 1 } },
    payload: {
      chatId: "other-owner",
      telegramContext: { transportChatId: -999, messageThreadId: 1 },
      prompt: "safe"
    }
  }), {
    kind: "agent_task",
    payload: { prompt: "safe" }
  });
});

test("tool output materialization stores routing outside task payloads", async () => {
  let capturedTasks;
  let capturedDefaults;
  const taskStore = {
    async addMany(tasks, defaults) {
      capturedTasks = tasks;
      capturedDefaults = defaults;
      return tasks;
    }
  };
  const artifactStore = {
    forChat() {
      return {
        async createText() { throw new Error("unexpected text artifact"); },
        async createFromFile() { throw new Error("unexpected file artifact"); }
      };
    }
  };
  const route = { transport: "telegram", destination: { chatId: -1001, threadId: 87 } };

  await materializeToolOutput({
    result: {
      asyncTask: {
        kind: "agent_task",
        route: { transport: "telegram", destination: { chatId: -999, threadId: 1 } },
        payload: { chatId: "other", prompt: "run" }
      }
    },
    name: "scheduler",
    chatId: "owner",
    artifactStore,
    taskStore,
    taskContext: route
  });

  assert.deepEqual(capturedTasks, [{ kind: "agent_task", payload: { prompt: "run" } }]);
  assert.deepEqual(capturedDefaults, {
    payload: { chatId: "owner" },
    route,
    source: { type: "tool", toolName: "scheduler", chatId: "owner" }
  });
});
