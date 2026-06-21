import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function sendText(res, statusCode, text, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers
  });
  res.end(text);
}

function safePathname(req) {
  try {
    return new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function methodKey(method, routePath) {
  return `${String(method || "GET").toUpperCase()} ${routePath}`;
}

function extractBearerToken(req, parsedUrl) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return parsedUrl.searchParams.get("token") || "";
}

function timingSafeEqualString(actual, expected) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function installBodyLimit(req, res, limitBytes) {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > limitBytes) {
    sendText(res, 413, "request body too large\n");
    req.destroy();
    return false;
  }

  let total = 0;
  const originalEmit = req.emit;
  req.emit = function emitWithBodyLimit(eventName, ...args) {
    if (eventName === "data" && !res.writableEnded) {
      const chunk = args[0];
      total += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk || ""));
      if (total > limitBytes) {
        sendText(res, 413, "request body too large\n");
        req.destroy();
        return false;
      }
    }
    return originalEmit.call(this, eventName, ...args);
  };
  return true;
}

function parseChatId(parsedUrl) {
  const raw = parsedUrl.searchParams.get("chatId");
  if (raw == null || raw.trim() === "") return null;
  const numberValue = Number(raw);
  return Number.isSafeInteger(numberValue) ? numberValue : raw;
}

export function createWebRouter({
  getRoutes,
  buildContext,
  getToken,
  logger,
  limits = {}
} = {}) {
  const coreRoutes = new Map();
  const handlerCache = new Map();
  const bodyLimitBytes = limits.bodyLimitBytes || DEFAULT_BODY_LIMIT_BYTES;
  const timeoutMs = limits.timeoutMs || DEFAULT_TIMEOUT_MS;

  async function loadHandler(route) {
    if (!handlerCache.has(route.handlerPath)) {
      handlerCache.set(route.handlerPath, import(pathToFileURL(route.handlerPath).href));
    }
    const module = await handlerCache.get(route.handlerPath);
    if (typeof module.handleWebRequest !== "function") {
      throw new Error(`handler does not export handleWebRequest: ${route.handlerPath}`);
    }
    return module.handleWebRequest;
  }

  function registerCoreRoute({ method, path, handler }) {
    if (typeof method !== "string" || typeof path !== "string" || typeof handler !== "function") {
      throw new Error("core route requires method, path, and handler");
    }
    coreRoutes.set(methodKey(method, path), handler);
  }

  async function dispatch(req, res) {
    const parsedUrl = new URL(req.url || "/", "http://localhost");
    const pathname = parsedUrl.pathname;
    const method = String(req.method || "GET").toUpperCase();
    const coreHandler = coreRoutes.get(methodKey(method, pathname));
    if (coreHandler) {
      return coreHandler(req, res);
    }

    const route = (getRoutes?.() || []).find((item) => item.path === pathname);
    if (!route) {
      sendText(res, 200, "ok");
      return undefined;
    }

    const timeout = setTimeout(() => {
      sendText(res, 504, "request timed out\n");
      req.destroy();
    }, timeoutMs);
    timeout.unref?.();

    try {
      if (!installBodyLimit(req, res, bodyLimitBytes)) return undefined;

      const token = getToken?.() || "";
      if (!route.public && !timingSafeEqualString(extractBearerToken(req, parsedUrl), token)) {
        sendText(res, 401, "unauthorized\n", { "WWW-Authenticate": "Bearer" });
        return undefined;
      }

      const methods = route.methods || ["GET"];
      if (!methods.includes(method)) {
        sendText(res, 405, "method not allowed\n", { Allow: methods.join(", ") });
        return undefined;
      }

      logger?.log?.("web", `${route.toolName} ${method} ${pathname}`);
      const handleWebRequest = await loadHandler(route);
      const context = buildContext?.({
        toolName: route.toolName,
        route,
        req,
        res,
        parsedUrl,
        chatId: parseChatId(parsedUrl)
      }) || { toolName: route.toolName, chatId: parseChatId(parsedUrl) };
      await handleWebRequest(req, res, context);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.error?.("web", `${route.toolName} ${safePathname(req)}: ${message}`);
      sendText(res, 500, "internal server error\n");
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    dispatch,
    registerCoreRoute
  };
}
