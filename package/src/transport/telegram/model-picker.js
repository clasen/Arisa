import { formatPiModelOption } from "../../core/agent/pi-runtime.js";
import { buildPagedInlineKeyboard } from "./paged-inline-keyboard.js";

export function reverseModelOrder(models) {
  return [...models].reverse();
}

export function parseModelPickerAction(data) {
  if (data === "noop:page") return { type: "noop", value: null };
  const match = /^(model|model-page):(\d+)$/.exec(String(data || ""));
  if (!match) return null;
  return {
    type: match[1] === "model" ? "select" : "page",
    value: Number(match[2])
  };
}

export function parseEffortPickerAction(data) {
  if (data === "noop:page") return { type: "noop", value: null };
  const modelEffort = /^model-effort:(\d+):([a-z]+)$/.exec(String(data || ""));
  if (modelEffort) {
    return {
      type: "model-effort",
      modelIndex: Number(modelEffort[1]),
      level: modelEffort[2]
    };
  }
  const effort = /^effort:([a-z]+)$/.exec(String(data || ""));
  if (effort) {
    return {
      type: "effort",
      level: effort[1]
    };
  }
  return null;
}

export function buildModelPicker({ provider, models, selectedModelId, selectedThinkingLevel, page, pageSize }) {
  if (!models.length) {
    throw new Error(`No models available for provider ${provider}`);
  }
  const items = models.map((model) => ({
    text: `${model.id === selectedModelId ? "✓ " : ""}${formatPiModelOption(model)}`
  }));
  const effortLine = selectedThinkingLevel ? `\nEffort: ${selectedThinkingLevel}` : "";
  return {
    text: `Current model: ${provider}/${selectedModelId}${effortLine}\nSelect a model for this chat:`,
    replyMarkup: buildPagedInlineKeyboard("model", items, { page, pageSize })
  };
}

export function buildEffortPicker({
  provider,
  modelId,
  levels,
  selectedThinkingLevel,
  modelIndex
}) {
  if (!levels.length) {
    throw new Error(`No effort levels available for ${provider}/${modelId}`);
  }
  const rows = levels.map((level) => ([{
    text: `${level === selectedThinkingLevel ? "✓ " : ""}${level}`,
    callback_data: modelIndex == null ? `effort:${level}` : `model-effort:${modelIndex}:${level}`
  }]));
  const scope = modelIndex == null
    ? `Current model: ${provider}/${modelId}\nSelect effort for this chat:`
    : `Model: ${provider}/${modelId}\nSelect effort:`;
  return {
    text: scope,
    replyMarkup: { inline_keyboard: rows }
  };
}
