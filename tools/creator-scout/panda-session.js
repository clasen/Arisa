import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const CREATOR_SCOUT_RESOURCE = "www.creatorscout.dev";
const LIGHTPANDA_TOOL = "lightpanda-browser";

async function seedBridgeSession(chatId, getChatToolStateDir) {
  const stateDir = getChatToolStateDir(String(chatId), "browser-session-bridge");
  const sessionsDir = path.join(stateDir, "sessions");
  const file = path.join(sessionsDir, `${CREATOR_SCOUT_RESOURCE}.json`);
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const session = {
    version: 2,
    resourceId: CREATOR_SCOUT_RESOURCE,
    sourceUrl: `https://${CREATOR_SCOUT_RESOURCE}`,
    capturedAt: now,
    receivedAt: now,
    cookies: [],
    webStorage: { local: { "arisa.profile": "creator-scout-panda" }, session: {} }
  };
  await writeFile(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600, flag: "wx" }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
}

function toolOutput(result, operation) {
  if (!result?.ok) throw new Error(result?.error || `Lightpanda ${operation} failed`);
  return result.output?.json || {};
}

export async function openPandaSession({ arisa, chatId, getChatToolStateDir, timeoutMs }) {
  await seedBridgeSession(chatId, getChatToolStateDir);
  const opened = await arisa.tools.run({
    name: LIGHTPANDA_TOOL,
    args: { mode: "session-open-authenticated", resourceId: CREATOR_SCOUT_RESOURCE }
  }, { timeoutMs });
  const sessionId = toolOutput(opened, "session-open-authenticated").id;
  if (!sessionId) throw new Error("Lightpanda did not return a CreatorScout session id");
  let closed = false;

  async function call(tool, toolArgs = {}, permission = {}) {
    const result = await arisa.tools.run({
      name: LIGHTPANDA_TOOL,
      args: {
        mode: "session-call",
        sessionId,
        tool,
        toolArgs: JSON.stringify(toolArgs),
        actionLevel: permission.actionLevel || "read",
        ...(permission.commitIntent ? { commitIntent: permission.commitIntent } : {})
      }
    }, { timeoutMs });
    return toolOutput(result, tool);
  }

  async function close() {
    if (closed) return;
    closed = true;
    const result = await arisa.tools.run({
      name: LIGHTPANDA_TOOL,
      args: { mode: "session-close", sessionId }
    }, { timeoutMs: Math.min(timeoutMs, 60_000) });
    toolOutput(result, "session-close");
  }

  return { sessionId, call, close };
}

export async function gotoWithRetry(session, url, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await session.call("goto", { url });
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError;
}

export async function semanticTree(session) {
  return String((await session.call("tree")).text || "");
}

export async function interactiveElements(session) {
  const text = String((await session.call("interactiveElements", { limit: 100 })).text || "[]");
  const elements = JSON.parse(text);
  if (!Array.isArray(elements)) throw new Error("Lightpanda returned invalid interactive elements");
  return elements;
}

export async function clickNamedControl(session, name, permission = {}) {
  const elements = await interactiveElements(session);
  const control = elements.find((element) => element.name === name);
  if (!control?.backendNodeId) throw new Error(`CreatorScout control was not found: ${name}`);
  return session.call("click", { backendNodeId: control.backendNodeId }, permission);
}

export async function pandaSignedIn(session) {
  await gotoWithRetry(session, "https://www.creatorscout.dev/saved");
  return /button 'Sign out'/.test(await semanticTree(session));
}
