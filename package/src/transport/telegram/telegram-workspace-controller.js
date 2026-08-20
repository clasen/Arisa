import { authorizeChat } from "./auth.js";
import { resolveTelegramWorkspaceRoute } from "./workspace-group.js";

function incomingChatMeta(ctx) {
  return {
    languageCode: ctx.from?.language_code || "",
    username: ctx.from?.username || "",
    firstName: ctx.from?.first_name || "",
    lastName: ctx.from?.last_name || ""
  };
}

export function createTelegramWorkspaceController({ config, api, saveConfig }) {
  const routes = new WeakMap();
  const gateStates = new Map();

  async function authorizeContext(ctx) {
    const route = await resolveTelegramWorkspaceRoute({ config, api: ctx.api || api, ctx });
    if (!route.workspace) {
      const authorization = await authorizeChat({
        config,
        chatId: ctx.chat.id,
        saveConfig,
        chatMeta: incomingChatMeta(ctx)
      });
      if (authorization.ok) routes.set(ctx, route);
      return authorization;
    }

    const gateKey = String(ctx.chat.id);
    const previous = gateStates.get(gateKey);
    if (!route.ok) {
      gateStates.set(gateKey, route.reason || "locked");
      if (previous !== (route.reason || "locked")) {
        await ctx.reply("Private workspace access is paused because this forum is no longer owner-only.").catch(() => {});
      }
      return { ok: false, reason: route.reason || "workspace-locked" };
    }
    if (!(config.telegram.authorizedChatIds || []).includes(route.ownerChatId)) {
      return { ok: false, reason: "owner-not-authorized" };
    }
    routes.set(ctx, route);
    gateStates.set(gateKey, "ready");
    if (previous && previous !== "ready") {
      await ctx.reply("Private workspace access restored.").catch(() => {});
    }
    return { ok: true, firstTime: false, workspace: true };
  }

  function contextRoute(ctx) {
    return routes.get(ctx) || {
      ok: true,
      workspace: false,
      sessionId: String(ctx.chat.id),
      scopeChatId: ctx.chat.id,
      transportChatId: ctx.chat.id,
      threadId: null
    };
  }

  return {
    authorizeContext,
    contextRoute,
    registerRoute: (ctx, route) => routes.set(ctx, route)
  };
}
