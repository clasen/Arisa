export function createChatStateStore() {
  const states = new Map();

  function reset(chatId) {
    const state = {
      processing: false,
      pendingPrompts: [],
      pendingPromptContexts: [],
      pendingPromptReceipts: [],
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

export function createPromptExecutionReceipt() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function rejectQueuedReceipts(chatState, error) {
  for (const receipt of chatState.pendingPromptReceipts || []) receipt?.reject(error);
}

export function queueChatPrompt(chatState, prompt, { replace = false, ctx = null, receipt = null } = {}) {
  chatState.pendingPromptContexts ||= [];
  chatState.pendingPromptReceipts ||= [];
  if (replace) {
    rejectQueuedReceipts(chatState, Object.assign(new Error("Queued prompt was superseded"), { code: "PROMPT_SUPERSEDED" }));
    chatState.pendingPrompts = [];
    chatState.pendingPromptContexts = [];
    chatState.pendingPromptReceipts = [];
  }
  chatState.pendingPrompts.push(prompt);
  chatState.pendingPromptContexts.push(ctx);
  chatState.pendingPromptReceipts.push(receipt);
}

function takeQueuedPrompt(chatState) {
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

export async function routeBusyPrompt({ chatState, prompt, mode = "queue", replaceQueued = false, ctx = null, receipt = null }) {
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
      queueChatPrompt(chatState, prompt, { ctx, receipt });
      return { disposition: "queued", steerError: error };
    }
  }

  queueChatPrompt(chatState, prompt, { replace: replaceQueued, ctx, receipt });
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
