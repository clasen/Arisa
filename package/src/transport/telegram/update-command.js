const callbackPrefix = "arisa-update:";

function callbackMessage(ctx) {
  return {
    chatId: ctx.chat.id,
    messageId: ctx.callbackQuery.message.message_id
  };
}

async function editCallbackMessage(ctx, text, extra) {
  const { chatId, messageId } = callbackMessage(ctx);
  return extra
    ? ctx.api.editMessageText(chatId, messageId, text, extra)
    : ctx.api.editMessageText(chatId, messageId, text);
}

export function buildUpdatePicker(report) {
  const rows = [];
  if (report.core.updateAvailable) {
    rows.push([{
      text: `Update Arisa → ${report.core.latestVersion}`,
      callback_data: `${callbackPrefix}core:${report.core.latestVersion}`
    }]);
  }
  if (report.tools.updateable.length) {
    rows.push([{
      text: `Update safe tools (${report.tools.updateable.length})`,
      callback_data: `${callbackPrefix}tools`
    }]);
  }
  rows.push(rows.length
    ? [{ text: "Not now", callback_data: `${callbackPrefix}close` }]
    : [{ text: "Up to date", callback_data: `${callbackPrefix}noop` }]);
  return { replyMarkup: { inline_keyboard: rows } };
}

export function parseUpdateAction(data) {
  if (data === `${callbackPrefix}tools`) return { type: "tools" };
  if (data === `${callbackPrefix}close`) return { type: "close" };
  if (data === `${callbackPrefix}noop`) return { type: "noop" };
  const core = String(data || "").match(/^arisa-update:core:(\d+\.\d+\.\d+)$/);
  return core ? { type: "core", targetVersion: core[1] } : null;
}

export function formatOfficialToolUpdateResult(result) {
  const lines = result.updated.length
    ? ["Updated official tools:", ...result.updated.map((name) => `- ${name}`)]
    : ["Official tools were already up to date."];
  if (result.skipped.length) {
    lines.push("", "Not changed (needs review):");
    for (const item of result.skipped) lines.push(`- ${item.name} [${item.status}]`);
  }
  return lines.join("\n");
}

export function createTelegramUpdateCallbackHandler({ authorize, updateCore, updateTools, requestRestart, logger }) {
  let updateInProgress = false;

  return async function handleTelegramUpdateCallback(ctx) {
    const action = parseUpdateAction(ctx.callbackQuery.data);
    if (!action) return false;

    const auth = await authorize(ctx);
    if (!auth.ok) {
      await ctx.answerCallbackQuery({ text: "This chat is not authorized.", show_alert: true });
      return true;
    }
    if (action.type === "noop") {
      await ctx.answerCallbackQuery({ text: "Arisa and official tools are up to date." });
      return true;
    }
    if (action.type === "close") {
      await ctx.answerCallbackQuery();
      await editCallbackMessage(ctx, "Update cancelled.");
      return true;
    }
    if (updateInProgress) {
      await ctx.answerCallbackQuery({ text: "An update is already in progress.", show_alert: true });
      return true;
    }

    updateInProgress = true;
    const coreUpdate = action.type === "core";
    try {
      await ctx.answerCallbackQuery({ text: coreUpdate ? "Updating Arisa…" : "Updating safe tools…" });
      if (coreUpdate) {
        await editCallbackMessage(ctx, `Updating Arisa to ${action.targetVersion}…`);
        const result = await updateCore(action.targetVersion);
        if (!result.updated) {
          await editCallbackMessage(ctx, `Arisa ${result.currentVersion} is already up to date.`);
          return true;
        }
        await editCallbackMessage(
          ctx,
          `Arisa updated from ${result.previousVersion} to ${result.currentVersion}. Restarting…`
        );
        try {
          await requestRestart(ctx);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger?.error("update", `restart after update failed: ${message}`);
          await editCallbackMessage(
            ctx,
            `Arisa updated to ${result.currentVersion}, but restart failed: ${message}\nRun /restart to activate it.`
          );
        }
        return true;
      }

      await editCallbackMessage(ctx, "Updating safe official tools…");
      await editCallbackMessage(ctx, formatOfficialToolUpdateResult(await updateTools(ctx.chat.id)));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.error("update", `update action failed: ${message}`);
      await editCallbackMessage(ctx, `Arisa update failed: ${message}`).catch(() => {});
      return true;
    } finally {
      updateInProgress = false;
    }
  };
}
