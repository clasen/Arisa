import path from "node:path";

export const RESERVED_EXACT = ["/"];
export const RESERVED_PATHS = ["/health"];
export const RESERVED_PREFIXES = ["/telegram-", "/api", "/auth"];

const DEFAULT_METHODS = ["GET"];

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeMethods(methods, isPublic) {
  const requested = methods == null ? DEFAULT_METHODS : methods;
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new Error("methods must be a non-empty array");
  }

  const normalized = requested.map((method) => {
    if (typeof method !== "string" || !method.trim()) {
      throw new Error("methods must contain only non-empty strings");
    }
    return method.trim().toUpperCase();
  });

  if (!isPublic && methods == null) return normalized;
  return [...new Set(normalized)];
}

export function isReservedPath(routePath) {
  return RESERVED_EXACT.includes(routePath)
    || RESERVED_PATHS.includes(routePath)
    || RESERVED_PREFIXES.some((prefix) => routePath === prefix || routePath.startsWith(prefix));
}

export function validateRoutePath(routePath) {
  if (typeof routePath !== "string" || !routePath.startsWith("/")) {
    throw new Error("path must be a string that starts with /");
  }
  if (routePath.includes("..")) {
    throw new Error("path must not contain ..");
  }
  if (isReservedPath(routePath)) {
    throw new Error(`path is reserved: ${routePath}`);
  }
  return routePath;
}

export function resolveHandlerWithinTool(toolDir, handlerRel) {
  if (typeof handlerRel !== "string" || !handlerRel.trim()) {
    throw new Error("handler must be a non-empty string");
  }
  if (path.isAbsolute(handlerRel)) {
    throw new Error("handler must be relative to the tool directory");
  }
  if (handlerRel.includes("..")) {
    throw new Error("handler must not contain ..");
  }

  const root = path.resolve(toolDir);
  const handlerPath = path.resolve(root, handlerRel);
  const relative = path.relative(root, handlerPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("handler must resolve inside the tool directory");
  }
  return handlerPath;
}

export function validateToolWebRoutes(manifest, toolDir, claimedPaths = new Map()) {
  const routes = [];
  const errors = [];
  const toolName = manifest?.name;
  const manifestRoutes = manifest?.web?.routes;

  if (manifestRoutes == null) return { routes, errors };
  if (!Array.isArray(manifestRoutes)) {
    return { routes, errors: [{ toolName, error: "web.routes must be an array" }] };
  }

  for (const [index, route] of manifestRoutes.entries()) {
    try {
      if (!isObject(route)) {
        throw new Error("route must be an object");
      }

      const routePath = validateRoutePath(route.path);
      const previousTool = claimedPaths.get(routePath);
      if (previousTool && previousTool !== toolName) {
        throw new Error(`path collides with tool ${previousTool}: ${routePath}`);
      }

      const isPublic = route.public === true;
      const methods = normalizeMethods(route.methods, isPublic);
      const handlerPath = resolveHandlerWithinTool(toolDir, route.handler);

      claimedPaths.set(routePath, toolName);
      routes.push({
        toolName,
        path: routePath,
        methods,
        public: isPublic,
        handlerPath
      });
    } catch (error) {
      errors.push({
        toolName,
        index,
        path: route?.path,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { routes, errors };
}
