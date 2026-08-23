const CONTROL_ARGUMENTS = new Set(["action", "arguments", "confirm", "endpoint", "profile", "replace", "tool"]);

export function availableTools(result) {
  const tools = result?.tools;
  if (!Array.isArray(tools)) throw new Error("MCP tool catalog was unavailable");
  return tools;
}

export function resolveRemoteTool(args, catalog) {
  const action = String(args?.action || "").trim();
  const requested = action === "call" ? String(args?.tool || "").trim() : action;
  if (!requested) throw new Error("tool is required");
  const names = new Set(catalog.map((tool) => tool?.name).filter(Boolean));
  if (!names.has(requested)) throw new Error(`MCP server does not provide tool: ${requested}`);
  return requested;
}

export function remoteArguments(args = {}) {
  if (args.arguments != null && args.arguments !== "") {
    if (typeof args.arguments === "object" && !Array.isArray(args.arguments)) return args.arguments;
    try {
      const parsed = JSON.parse(String(args.arguments));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
    throw new Error("arguments must be a JSON object");
  }
  return Object.fromEntries(Object.entries(args).filter(([key]) => !CONTROL_ARGUMENTS.has(key)));
}
