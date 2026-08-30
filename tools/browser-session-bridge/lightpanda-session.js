function assertResourceId(value) {
  const resourceId = String(value || "").trim().toLowerCase();
  if (!/^(?=.{1,253}$)[a-z0-9.-]+$/.test(resourceId) || resourceId.includes("..")) throw new Error("A valid resourceId hostname is required");
  return resourceId;
}

function assertSameSiteUrl(value, resourceId) {
  const url = new URL(String(value || ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only plain HTTP(S) URLs are supported");
  const hostname = url.hostname.toLowerCase();
  if (hostname !== resourceId && !hostname.endsWith(`.${resourceId}`) && !resourceId.endsWith(`.${hostname}`)) {
    throw new Error("URL hostname is outside the stored session scope");
  }
  return url;
}

async function runLightpanda(arisa, args, timeoutMs = 60_000) {
  const result = await arisa.tools.run({ name: "lightpanda-browser", args }, { timeoutMs });
  if (!result?.ok) throw new Error(result?.error || "Lightpanda session operation failed");
  return result.output || {};
}

function extractedPage(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { title: String(parsed.title || ""), text: String(parsed.text || "") };
    }
  } catch {}
  return { title: "", text: String(text || "") };
}

export async function openWithLightpanda({ arisa, resourceId: rawResourceId, deviceId = null, url: rawUrl, maxChars = 30_000 }) {
  const resourceId = assertResourceId(rawResourceId);
  const url = assertSameSiteUrl(rawUrl, resourceId);
  const boundedChars = Math.min(100_000, Math.max(1_000, Number(maxChars) || 30_000));
  const opened = await runLightpanda(arisa, { action: "session-open-authenticated", resourceId, ...(deviceId ? { deviceId } : {}) });
  const sessionId = String(opened.json?.id || "");
  if (!sessionId) throw new Error("Lightpanda did not return a session id");
  await runLightpanda(arisa, {
    action: "session-call",
    sessionId,
    tool: "goto",
    toolArgs: JSON.stringify({ url: url.href }),
    actionLevel: "read",
    maxOutputBytes: "4096"
  });
  const extracted = await runLightpanda(arisa, {
    action: "session-call",
    sessionId,
    tool: "extract",
    toolArgs: JSON.stringify({ schema: JSON.stringify({ title: "title", text: "body" }) }),
    actionLevel: "read",
    maxOutputBytes: String(Math.min(131_072, Math.max(4_096, boundedChars * 4)))
  });
  const page = extractedPage(extracted.text);
  return {
    engine: "lightpanda",
    resourceId,
    ...(deviceId ? { deviceId } : {}),
    sessionId,
    reused: opened.json?.reused === true,
    url: String(extracted.json?.finalUrl || url.href),
    title: page.title.slice(0, 1_000),
    text: page.text.slice(0, boundedChars)
  };
}
