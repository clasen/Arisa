const RESERVED_ARGUMENTS = new Set(["action", "tool", "arguments", "confirm"]);

export function toolCatalog(result) {
  const tools = result?.output?.json?.tools;
  if (!result?.ok || !Array.isArray(tools)) throw new Error(result?.error || "Magnific MCP tool catalog was unavailable");
  return tools;
}

export async function listMagnificTools(arisa, profile, timeoutMs = 120000) {
  const result = await arisa.tools.run({
    name: "mcp-client",
    args: { action: "tools", profile }
  }, { timeoutMs });
  return toolCatalog(result);
}

export function forwardedArguments(args = {}) {
  if (args.arguments != null) {
    if (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) {
      throw new Error("arguments must be an object");
    }
    return args.arguments;
  }
  return Object.fromEntries(Object.entries(args).filter(([key]) => !RESERVED_ARGUMENTS.has(key)));
}

export function resolveMcpTool(args, catalog) {
  const action = String(args?.action || "").trim();
  const requested = action === "call" ? String(args?.tool || "").trim() : action;
  if (!requested) throw new Error("tool is required");
  const available = new Set(catalog.map((tool) => tool?.name).filter(Boolean));
  if (!available.has(requested)) throw new Error(`Magnific MCP does not provide tool: ${requested}`);
  return requested;
}
