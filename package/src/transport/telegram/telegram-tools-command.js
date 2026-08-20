import { getErrorMessage } from "../../core/agent/auth-flow.js";
import { formatToolUsageReport } from "../../runtime/tool-usage-report.js";
import { renderTelegramHtml } from "./text-format.js";

export function createTelegramToolsCommandHandler({
  authorize,
  contextRoute,
  toolRegistry,
  withTyping,
  logger
}) {
  return async (ctx) => {
    logger?.log("telegram", `/tools command received in chat ${ctx.chat.id}`);
    return withTyping(ctx, async () => {
      const auth = await authorize(ctx);
      if (!auth.ok) return;
      try {
        const report = await toolRegistry.usage(contextRoute(ctx).scopeChatId);
        await ctx.reply(renderTelegramHtml(formatToolUsageReport(report)), { parse_mode: "HTML" });
        logger?.log("telegram", `/tools command completed in chat ${ctx.chat.id}`);
      } catch (error) {
        const message = getErrorMessage(error);
        logger?.error("telegram", `/tools command failed in chat ${ctx.chat.id}: ${message}`);
        await ctx.reply(`Tool usage report failed: ${message}`);
      }
    });
  };
}
