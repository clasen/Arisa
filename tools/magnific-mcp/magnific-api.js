function parseTextJson(content) {
  for (const item of content || []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try { return JSON.parse(item.text); } catch {}
  }
  return null;
}

export function mcpData(result) {
  const json = result?.output?.json;
  if (!result?.ok || json?.isError) throw new Error(json?.content?.[0]?.text || result?.error || "Magnific MCP call failed");
  return json?.structuredContent || parseTextJson(json?.content) || json;
}

export async function runMagnificClient(arisa, profile, args, timeoutMs = 120000) {
  const result = await arisa.tools.run({
    name: "mcp-client",
    args: { ...args, profile, ...(args.action === "tools" ? {} : { confirm: true }) }
  }, { timeoutMs });
  return mcpData(result);
}

export function callMagnific(arisa, profile, tool, args = {}, timeoutMs = 120000) {
  return runMagnificClient(arisa, profile, { action: "call", tool, arguments: args }, timeoutMs);
}

export function findFirst(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) if (value[key] != null) return value[key];
  if (typeof value.text === "string") {
    for (const key of keys) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = value.text.match(new RegExp(`(?:^|\\n)${escaped}:\\s*("(?:[^"\\\\]|\\\\.)*"|[^\\n]+)`));
      if (match) {
        try { return JSON.parse(match[1]); } catch { return match[1].trim(); }
      }
    }
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const found = findFirst(child, keys);
      if (found != null) return found;
    }
  }
  return null;
}

export function findAll(value, key, found = []) {
  if (!value || typeof value !== "object") return found;
  if (value[key] != null) found.push(value[key]);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") findAll(child, key, found);
  }
  return found;
}

export function findUpload(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.url === "string" && typeof value.path === "string") return value;
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const found = findUpload(child);
      if (found) return found;
    }
  }
  return null;
}
