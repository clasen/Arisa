import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatStateStore,
  createPromptExecutionReceipt,
  drainChatPromptQueue,
  queueChatPrompt
} from "../src/transport/telegram/chat-queue.js";

test("execution receipts start only when their queued prompt begins", async () => {
  const state = createChatStateStore().get("chat-1");
  const starts = [];
  const receipt = createPromptExecutionReceipt(() => starts.push("second"));
  queueChatPrompt(state, "second", { receipt });
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });

  const draining = drainChatPromptQueue({
    chatState: state,
    initialPrompt: "first",
    processPrompt: async ({ prompt }) => {
      if (prompt === "first") await first;
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, []);
  releaseFirst();
  await draining;
  assert.deepEqual(starts, ["second"]);
  await receipt.promise;
});
