import { getErrorMessage } from "../../core/agent/auth-flow.js";
import { resolveChatModel, resolveChatSpeed, resolveChatThinkingLevel } from "../../core/agent/model-selection.js";
import { clampModelThinkingLevel, listModelThinkingLevels, modelSupportsThinking } from "../../core/agent/pi-runtime.js";
import { modelSupportsSpeed } from "../../core/agent/model-speed.js";
import { parseEffortPickerAction, parseModelPickerAction, parseSpeedPickerAction } from "./model-picker.js";

export async function closeModelPicker(ctx, { messageText, callbackText }) {
  await ctx.api.editMessageText(
    ctx.chat.id,
    ctx.callbackQuery.message.message_id,
    messageText
  );
  await ctx.answerCallbackQuery({ text: callbackText });
}

export function createTelegramModelCallbackHandler({
  config,
  authorizeContext,
  contextRoute,
  getChatState,
  getProviderModels,
  showModelPicker,
  showEffortPicker,
  persistChatModel,
  persistChatEffort,
  persistChatSpeed,
  logger
}) {
  return async (ctx, next) => {
    const modelAction = parseModelPickerAction(ctx.callbackQuery.data);
    const effortAction = modelAction ? null : parseEffortPickerAction(ctx.callbackQuery.data);
    const speedAction = modelAction || effortAction ? null : parseSpeedPickerAction(ctx.callbackQuery.data);
    const action = modelAction || effortAction || speedAction;
    if (!action) return next();
    if (action.type === "noop") {
      await ctx.answerCallbackQuery();
      return;
    }

    const auth = await authorizeContext(ctx);
    if (!auth.ok) {
      await ctx.answerCallbackQuery({ text: "This chat is not authorized.", show_alert: true });
      return;
    }

    const modelChatId = contextRoute(ctx).sessionId;

    try {
      if (action.type === "page") {
        await showModelPicker(ctx, action.value);
        await ctx.answerCallbackQuery();
        return;
      }

      const models = await getProviderModels(modelChatId);
      const chatBusy = getChatState(modelChatId).processing;

      if (action.type === "select") {
        const model = models[action.value];
        if (!model) {
          await ctx.answerCallbackQuery({ text: "This model list is no longer current. Run /model again.", show_alert: true });
          return;
        }
        if (modelSupportsThinking(model)) {
          await showEffortPicker(ctx, {
            model,
            modelIndex: action.value,
            selectedThinkingLevel: clampModelThinkingLevel(model, resolveChatThinkingLevel(config, modelChatId))
          });
          await ctx.answerCallbackQuery({ text: `Choose effort for ${model.id}.` });
          return;
        }
        if (chatBusy) {
          await ctx.answerCallbackQuery({ text: "Wait for the current response before changing models.", show_alert: true });
          return;
        }

        const currentModelId = resolveChatModel(config, modelChatId);
        const currentEffort = resolveChatThinkingLevel(config, modelChatId);
        if (model.id === currentModelId && currentEffort === "off") {
          await closeModelPicker(ctx, {
            messageText: `Already using ${model.provider}/${model.id}.`,
            callbackText: `Already using ${model.id}.`
          });
          return;
        }

        await persistChatModel(modelChatId, model, "off");
        await ctx.api.editMessageText(
          ctx.chat.id,
          ctx.callbackQuery.message.message_id,
          `Model changed to ${model.provider}/${model.id}.\nA new chat context will start with your next message.`
        );
        await ctx.answerCallbackQuery({ text: `Using ${model.id}.` });
        return;
      }

      if (action.type === "model-effort") {
        const model = models[action.modelIndex];
        if (!model) {
          await ctx.answerCallbackQuery({ text: "This model list is no longer current. Run /model again.", show_alert: true });
          return;
        }
        const levels = listModelThinkingLevels(model);
        if (!levels.includes(action.level)) {
          await ctx.answerCallbackQuery({ text: "That effort level is not available for this model.", show_alert: true });
          return;
        }

        const currentModelId = resolveChatModel(config, modelChatId);
        const currentEffort = resolveChatThinkingLevel(config, modelChatId);
        if (model.id === currentModelId && action.level === currentEffort) {
          await closeModelPicker(ctx, {
            messageText: `Already using ${model.provider}/${model.id} (effort: ${action.level}).`,
            callbackText: `Already using ${model.id} at ${action.level}.`
          });
          return;
        }
        if (model.id === currentModelId) {
          await persistChatEffort(modelChatId, model, action.level);
          await ctx.api.editMessageText(
            ctx.chat.id,
            ctx.callbackQuery.message.message_id,
            `Effort set to ${action.level} for ${model.provider}/${model.id}.`
          );
          await ctx.answerCallbackQuery({ text: `Effort: ${action.level}.` });
          return;
        }
        if (chatBusy) {
          await ctx.answerCallbackQuery({ text: "Wait for the current response before changing models.", show_alert: true });
          return;
        }

        await persistChatModel(modelChatId, model, action.level);
        await ctx.api.editMessageText(
          ctx.chat.id,
          ctx.callbackQuery.message.message_id,
          `Model changed to ${model.provider}/${model.id} (effort: ${action.level}).\nA new chat context will start with your next message.`
        );
        await ctx.answerCallbackQuery({ text: `Using ${model.id} / ${action.level}.` });
        return;
      }

      if (action.type === "effort") {
        const model = models.find((item) => item.id === resolveChatModel(config, modelChatId));
        if (!model) {
          await ctx.answerCallbackQuery({ text: "Current model is unavailable. Run /model again.", show_alert: true });
          return;
        }
        if (!modelSupportsThinking(model)) {
          await ctx.answerCallbackQuery({ text: "This model does not support effort levels.", show_alert: true });
          return;
        }
        const levels = listModelThinkingLevels(model);
        if (!levels.includes(action.level)) {
          await ctx.answerCallbackQuery({ text: "That effort level is not available for this model.", show_alert: true });
          return;
        }
        const currentEffort = resolveChatThinkingLevel(config, modelChatId);
        if (action.level === currentEffort) {
          await closeModelPicker(ctx, {
            messageText: `Already using effort ${action.level} for ${model.provider}/${model.id}.`,
            callbackText: `Already using effort ${action.level}.`
          });
          return;
        }
        await persistChatEffort(modelChatId, model, action.level);
        await ctx.api.editMessageText(
          ctx.chat.id,
          ctx.callbackQuery.message.message_id,
          `Effort set to ${action.level} for ${model.provider}/${model.id}.`
        );
        await ctx.answerCallbackQuery({ text: `Effort: ${action.level}.` });
        return;
      }

      if (action.type === "speed") {
        const model = models.find((item) => item.id === resolveChatModel(config, modelChatId));
        if (!model) {
          await ctx.answerCallbackQuery({ text: "Current model is unavailable. Run /model again.", show_alert: true });
          return;
        }
        if (!modelSupportsSpeed(model)) {
          await ctx.answerCallbackQuery({ text: "This model does not support speed 1.5x.", show_alert: true });
          return;
        }
        const currentSpeed = resolveChatSpeed(config, modelChatId);
        if (action.speed === currentSpeed) {
          await closeModelPicker(ctx, {
            messageText: `Already using speed ${action.speed.toFixed(1)}x for ${model.provider}/${model.id}.`,
            callbackText: `Already using speed ${action.speed.toFixed(1)}x.`
          });
          return;
        }
        await persistChatSpeed(modelChatId, model, action.speed);
        await ctx.api.editMessageText(
          ctx.chat.id,
          ctx.callbackQuery.message.message_id,
          `Speed set to ${action.speed.toFixed(1)}x for ${model.provider}/${model.id}.`
        );
        await ctx.answerCallbackQuery({ text: `Speed: ${action.speed.toFixed(1)}x.` });
      }
    } catch (error) {
      logger?.error("telegram", `model selection failed for chat ${ctx.chat.id}: ${getErrorMessage(error)}`);
      await ctx.answerCallbackQuery({
        text: "Could not change the model, effort, or speed.",
        show_alert: true
      }).catch(() => {});
    }
  };
}
