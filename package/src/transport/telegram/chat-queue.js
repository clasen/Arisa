export function createChatStateStore() {
  const states = new Map();

  function reset(chatId) {
    const state = {
      processing: false,
      pendingPrompts: [],
      pendingPromptContexts: [],
      pendingPromptReceipts: [],
      pendingPromptCoalescible: [],
      continueAfterClose: false,
      historyRevision: 0,
      beforeNextPrompt: null,
      activeSession: null,
      assistantMessages: new Map(),
      stopQueuedTyping: null
    };
    states.set(String(chatId), state);
    return state;
  }

  return {
    get(chatId) {
      const key = String(chatId);
      return states.get(key) || reset(key);
    },
    reset,
    anyProcessing() {
      return [...states.values()].some((state) => state.processing);
    }
  };
}

export function createPromptExecutionReceipt(onStart = null) {
  let resolve;
  let reject;
  let started = false;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve,
    reject,
    start() {
      if (started) return;
      started = true;
      onStart?.({ resolve, reject, promise });
    }
  };
}

function rejectQueuedReceipts(chatState, error) {
  for (const receipt of chatState.pendingPromptReceipts || []) receipt?.reject(error);
}

const COALESCED_PROMPT_SEPARATOR = "\n\n--- next direct message ---\n\n";

function coalesceLastQueuedPrompt(chatState, prompt, ctx) {
  const coalescible = chatState.pendingPromptCoalescible ||= [];
  const index = chatState.pendingPrompts.length - 1;
  if (index < 0 || !coalescible[index]) return false;
  chatState.pendingPrompts[index] += `${COALESCED_PROMPT_SEPARATOR}${prompt}`;
  (chatState.pendingPromptContexts ||= [])[index] = ctx;
  return true;
}

export function queueChatPrompt(chatState, prompt, {
  replace = false,
  ctx = null,
  receipt = null,
  coalescible = false
} = {}) {
  chatState.pendingPromptContexts ||= [];
  chatState.pendingPromptReceipts ||= [];
  chatState.pendingPromptCoalescible ||= [];
  if (replace) {
    rejectQueuedReceipts(chatState, Object.assign(new Error("Queued prompt was superseded"), { code: "PROMPT_SUPERSEDED" }));
    chatState.pendingPrompts = [];
    chatState.pendingPromptContexts = [];
    chatState.pendingPromptReceipts = [];
    chatState.pendingPromptCoalescible = [];
  }
  chatState.pendingPrompts.push(prompt);
  chatState.pendingPromptContexts.push(ctx);
  chatState.pendingPromptReceipts.push(receipt);
  chatState.pendingPromptCoalescible.push(coalescible);
}

function takeQueuedPrompt(chatState) {
  (chatState.pendingPromptCoalescible ||= []).shift();
  return {
    prompt: chatState.pendingPrompts.shift() || "",
    ctx: (chatState.pendingPromptContexts ||= []).shift() || null,
    receipt: (chatState.pendingPromptReceipts ||= []).shift() || null
  };
}

export function resolveTelegramBusyMessageMode(config, chatId) {
  const chatMode = config.telegram?.chatMeta?.[String(chatId)]?.busyMessageMode;
  const mode = chatMode || config.telegram?.busyMessageMode;
  return mode === "steer" ? "steer" : "queue";
}

export async function routeBusyPrompt({
  chatState,
  prompt,
  mode = "queue",
  replaceQueued = false,
  ctx = null,
  receipt = null,
  coalesceQueued = false
}) {
  if (coalesceQueued && !replaceQueued && !receipt && coalesceLastQueuedPrompt(chatState, prompt, ctx)) {
    return { disposition: "coalesced" };
  }

  const session = chatState.activeSession;
  if (
    mode === "steer"
    && !replaceQueued
    && !chatState.continueAfterClose
    && !chatState.beforeNextPrompt
    && session?.isStreaming
    && typeof session.steer === "function"
    && !receipt
  ) {
    try {
      await session.steer(prompt);
      return { disposition: "steered" };
    } catch (error) {
      queueChatPrompt(chatState, prompt, { ctx, receipt, coalescible: coalesceQueued });
      return { disposition: "queued", steerError: error };
    }
  }

  queueChatPrompt(chatState, prompt, {
    replace: replaceQueued,
    ctx,
    receipt,
    coalescible: coalesceQueued
  });
  return { disposition: "queued" };
}

function stopQueuedTyping(chatState) {
  chatState.stopQueuedTyping?.();
  chatState.stopQueuedTyping = null;
}

export async function drainChatPromptQueue({
  chatState,
  initialPrompt,
  initialCtx = null,
  initialReceipt = null,
  processPrompt,
  onPromptFailure,
  onPromptInterrupted,
  beforeInitialPrompt
}) {
  let currentPrompt = initialPrompt;
  let currentCtx = initialCtx;
  let currentReceipt = initialReceipt;

  try {
    await beforeInitialPrompt?.();
    while (currentPrompt) {
      while (chatState.beforeNextPrompt) {
        const gate = chatState.beforeNextPrompt;
        await gate;
        if (chatState.beforeNextPrompt === gate) chatState.beforeNextPrompt = null;
      }
      if (chatState.continueAfterClose && chatState.pendingPrompts.length) {
        const queued = takeQueuedPrompt(chatState);
        currentPrompt = queued.prompt;
        currentCtx = queued.ctx;
        currentReceipt = queued.receipt;
        chatState.continueAfterClose = false;
      }
      try {
        currentReceipt?.start?.();
        await processPrompt({ prompt: currentPrompt, ctx: currentCtx, receipt: currentReceipt });
        currentReceipt?.resolve({ status: "completed" });
      } catch (error) {
        currentReceipt?.reject(error);
        if (chatState.continueAfterClose && chatState.pendingPrompts.length) {
          await onPromptInterrupted?.(error);
        } else {
          await onPromptFailure?.(error);
          throw error;
        }
      } finally {
        currentCtx = null;
        currentReceipt = null;
      }

      const queued = takeQueuedPrompt(chatState);
      currentPrompt = queued.prompt;
      currentCtx = queued.ctx;
      currentReceipt = queued.receipt;
      chatState.continueAfterClose = false;
    }
  } finally {
    stopQueuedTyping(chatState);
    chatState.processing = false;
    chatState.activeSession = null;
  }
}
