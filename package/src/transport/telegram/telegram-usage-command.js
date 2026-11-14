import { getErrorMessage } from "../../core/agent/auth-flow.js";
import { formatModelUsageReport } from "../../runtime/model-usage-report.js";
import { renderTelegramHtml } from "./text-format.js";

export function createTelegramUsageCommandHandler({ authorize, contextRoute, agentManager, config, logger }) {
  return async (ctx) => {
    const auth = await authorize(ctx);
    if (!auth.ok) return;
    try {
      const runs = await agentManager.modelUsage.list(contextRoute(ctx).scopeChatId);
      const report = formatModelUsageReport({
        runs,
        windowMs: config.pi.usage.windowMs,
        maxRows: config.pi.usage.reportRows
      });
      await ctx.reply(renderTelegramHtml(report), { parse_mode: "HTML" });
    } catch (error) {
      const message = getErrorMessage(error);
      logger?.error("telegram", `/usage command failed in chat ${ctx.chat.id}: ${message}`);
      await ctx.reply(`Token usage report failed: ${message}`);
    }
  };
}
