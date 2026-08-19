export function createChatStateStore() {
  const states = new Map();

  function reset(chatId) {
    const state = {
      processing: false,
      pendingPrompts: [],
      pendingPromptContexts: [],
      continueAfterClose: false,
      historyRevision: 0,
      beforeNextPrompt: null,
      activeSession: null,
      activeSteers: [],
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

export function queueChatPrompt(chatState, prompt, { replace = false, ctx = null } = {}) {
  chatState.pendingPromptContexts ||= [];
  if (replace) {
    chatState.pendingPrompts = [];
    chatState.pendingPromptContexts = [];
  }
  chatState.pendingPrompts.push(prompt);
  chatState.pendingPromptContexts.push(ctx);
}

function takeQueuedPrompt(chatState) {
  return {
    prompt: chatState.pendingPrompts.shift() || "",
    ctx: (chatState.pendingPromptContexts ||= []).shift() || null
  };
}

export function resolveTelegramBusyMessageMode(config, chatId) {
  const chatMode = config.telegram?.chatMeta?.[String(chatId)]?.busyMessageMode;
  const mode = chatMode || config.telegram?.busyMessageMode;
  return mode === "steer" ? "steer" : "queue";
}

export async function routeBusyPrompt({ chatState, prompt, mode = "queue", replaceQueued = false, ctx = null }) {
  const session = chatState.activeSession;
  if (
    mode === "steer"
    && !replaceQueued
    && !chatState.continueAfterClose
    && !chatState.beforeNextPrompt
    && session?.isStreaming
    && typeof session.steer === "function"
  ) {
    try {
      await session.steer(prompt);
      chatState.activeSteers.push(prompt);
      return { disposition: "steered" };
    } catch (error) {
      queueChatPrompt(chatState, prompt, { ctx });
      return { disposition: "queued", steerError: error };
    }
  }

  queueChatPrompt(chatState, prompt, { replace: replaceQueued, ctx });
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
  processPrompt,
  onPromptFailure,
  onPromptInterrupted,
  beforeInitialPrompt
}) {
  let currentPrompt = initialPrompt;
  let currentCtx = initialCtx;

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
        chatState.continueAfterClose = false;
      }
      try {
        await processPrompt({ prompt: currentPrompt, ctx: currentCtx });
      } catch (error) {
        if (chatState.continueAfterClose && chatState.pendingPrompts.length) {
          await onPromptInterrupted?.(error);
        } else {
          await onPromptFailure?.(error);
          throw error;
        }
      } finally {
        currentCtx = null;
      }

      const queued = takeQueuedPrompt(chatState);
      currentPrompt = queued.prompt;
      currentCtx = queued.ctx;
      chatState.continueAfterClose = false;
    }
  } finally {
    stopQueuedTyping(chatState);
    chatState.processing = false;
    chatState.activeSession = null;
    chatState.activeSteers = [];
  }
}
