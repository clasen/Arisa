export function parseListArgument(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  const text = String(value || "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");
    return parsed.map(String).map((item) => item.trim()).filter(Boolean);
  }
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

export function parseArgvArgument(value) {
  const parsed = Array.isArray(value) ? value : typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed[0] !== "gmail") {
    throw new Error('args.argv must be a native array or JSON-encoded array starting with "gmail"');
  }
  return parsed.map(String);
}
