import { couldBecomeSilentReply } from "./prompt-builders.js";
import { stripTrailingRoutingMarker } from "./reply-topic-routing.js";
import { renderTelegramHtml } from "./text-format.js";

const maxDraftSourceLength = 3500;
let lastDraftId = Date.now() % 1_000_000_000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// Keeps the text up to the last finished paragraph or code block, so a draft never shows a block
// that is still being written.
function closedBlocks(text) {
  const fences = [...text.matchAll(/```/g)].map((match) => match.index);
  if (fences.length % 2 === 1) return text.slice(0, fences.at(-1));
  const lastFenceEnd = fences.length ? fences.at(-1) + 3 : 0;
  const lastBreak = [...text.matchAll(/\n[ \t]*\n/g)].at(-1)?.index ?? 0;
  return text.slice(0, Math.max(lastFenceEnd, lastBreak));
}

export function draftPreview(text) {
  const visible = closedBlocks(stripTrailingRoutingMarker(text)).trim();
  if (!visible || couldBecomeSilentReply(visible)) return "";
  return visible.length > maxDraftSourceLength ? `…${visible.slice(-maxDraftSourceLength)}` : visible;
}

// Streams the reply being generated as an ephemeral Telegram draft. The final reply is still
// delivered as a regular message, which replaces the draft.
export function createReplyDraftStream({ api, chatId, threadId = null, intervalMs, keepAliveMs, logger, now = Date.now }) {
  lastDraftId += 1;
  const draftId = lastDraftId;
  let text = "";
  let sentPreview = null;
  let sentAt = 0;
  let sending = false;
  let closed = false;
  let stopped = false;
  let timer = null;

  function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function flush() {
    if (closed || sending) return;
    const preview = draftPreview(text);
    if (preview === sentPreview && now() - sentAt < keepAliveMs) return;
    sending = true;
    try {
      await api.sendMessageDraft(chatId, draftId, renderTelegramHtml(preview), {
        ...(threadId ? { message_thread_id: threadId } : {}),
        ...(preview ? { parse_mode: "HTML" } : {}),
        can_stop: true
      });
      sentPreview = preview;
      sentAt = now();
    } catch (error) {
      close();
      logger?.error("telegram", `reply draft stream closed for chat ${chatId}: ${errorMessage(error)}`);
    } finally {
      sending = false;
    }
  }

  timer = setInterval(flush, intervalMs);
  timer.unref?.();
  const started = flush();

  return {
    draftId,
    started,
    flush,
    close,
    update(nextText) {
      text = String(nextText || "");
    },
    text: () => text,
    markStopped() {
      stopped = true;
    },
    isStopped: () => stopped
  };
}
