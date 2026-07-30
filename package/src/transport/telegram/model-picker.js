import { formatPiModelOption } from "../../core/agent/pi-runtime.js";
import { buildPagedInlineKeyboard } from "./paged-inline-keyboard.js";

export function parseModelPickerAction(data) {
  if (data === "noop:page") return { type: "noop", value: null };
  const match = /^(model|model-page):(\d+)$/.exec(String(data || ""));
  if (!match) return null;
  return {
    type: match[1] === "model" ? "select" : "page",
    value: Number(match[2])
  };
}

export function buildModelPicker({ provider, models, selectedModelId, page, pageSize }) {
  if (!models.length) {
    throw new Error(`No models available for provider ${provider}`);
  }
  const items = models.map((model) => ({
    text: `${model.id === selectedModelId ? "✓ " : ""}${formatPiModelOption(model)}`
  }));
  return {
    text: `Current model: ${provider}/${selectedModelId}\nSelect a model for this chat:`,
    replyMarkup: buildPagedInlineKeyboard("model", items, { page, pageSize })
  };
}
