import { authorizeAction } from "./action-policy.js";
import { BrowserSessionManager } from "./session-manager.js";
import { cleanupStaleCaptures, writeCapture } from "./capture.js";
import { buildMcpCommand, McpProcess, normalizeInteractionSteps } from "./mcp-session.js";
import { boundUtf8, normalizeMaxOutputBytes } from "./output-bounds.js";
import { assertResourceUrl } from "./authenticated-profile.js";
import { validatePublicUrl } from "./url-security.js";

const healthUrl = "data:text/html,%3Ch1%20id%3Dhealth%3Ehealthy%3C%2Fh1%3E";
const healthSchema = '{"health":"#health"}';

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

async function createStartedClient(binary, config, options = {}) {
  const operationTimeoutMs = boundedInteger(config.TIMEOUT_MS, 30_000, 5_000, 60_000);
  const profile = options.authenticatedProfile || null;
  const client = new McpProcess(binary, buildMcpCommand(config, operationTimeoutMs, profile ? {
    authenticated: true,
    cookiePath: profile.cookiePath,
    cookieJarPath: profile.cookieJarPath
  } : {}), {
    timeoutMs: 0,
    maxCaptureBytes: 32 * 1024
  });
  const closeClient = client.close.bind(client);
  if (profile) {
    client.close = async () => {
      try {
        await closeClient();
        await profile.finish({ refresh: true });
      } catch (error) {
        await profile.finish({ refresh: false }).catch(() => {});
        throw error;
      }
    };
  }
  try {
    await client.start();
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

export function createPersistentSessionService({ binary, config, createClient = null, profileStore = null, now = Date.now, lookup = null, tmpDir = null }) {
  const manager = new BrowserSessionManager({
    createClient: createClient || ((options) => createStartedClient(binary, config, options)),
    ttlMs: boundedInteger(config.SESSION_TTL_MS, 300_000, 5_000, 30 * 60_000),
    maxSessions: boundedInteger(config.MAX_SESSIONS, 3, 1, 10),
    sweepIntervalMs: boundedInteger(config.SESSION_SWEEP_MS, 1_000, 100, 60_000),
    now
  });
  manager.start();

  async function finalPublicUrl(sessionId, signal) {
    try {
      const current = String(await manager.execute(sessionId, "getUrl", {}, { signal })).trim();
      return current ? (await validatePublicUrl(current, lookup ? { lookup } : undefined)).href : null;
    } catch (error) {
      if (/FrameNotLoaded|no page is loaded/i.test(error.message || "")) return null;
      throw error;
    }
  }

  async function processJob(payload, { signal } = {}) {
    const action = String(payload?.action || "").trim().toLowerCase();
    if (action === "session-open") return manager.open();
    if (action === "session-open-authenticated") {
      if (!profileStore) throw new Error("Authenticated Lightpanda profiles are unavailable.");
      const authenticatedProfile = await profileStore.open(payload.resourceId);
      try {
        return await manager.open({ authenticatedProfile, publicMetadata: authenticatedProfile.publicMetadata });
      } catch (error) {
        await authenticatedProfile.finish({ refresh: false }).catch(() => {});
        throw error;
      }
    }
    if (action === "session-close") return manager.close(payload.sessionId, "explicit");
    if (action === "session-list") return { sessions: manager.list() };
    if (action === "session-capture") {
      if (!tmpDir) throw new Error("Lightpanda capture tmp directory is unavailable.");
      const selector = String(payload.selector || "").trim();
      if (selector.length > 500) throw new Error("selector is too long.");
      await cleanupStaleCaptures(tmpDir);
      try {
        const result = await manager.executeResult(payload.sessionId, "screenshot", {
          ...(selector ? { selector } : {}),
          fullPage: payload.fullPage === true
        }, { signal });
        const finalUrl = await finalPublicUrl(payload.sessionId, signal);
        const capture = await writeCapture(result, { tmpDir, config });
        return {
          sessionId: payload.sessionId,
          finalUrl,
          filePath: capture.filePath,
          fileName: capture.fileName,
          mimeType: capture.mimeType,
          kind: "image",
          delivery: { method: "photo" },
          width: capture.width,
          height: capture.height,
          bytes: capture.bytes
        };
      } catch (error) {
        if (manager.has(payload.sessionId)) await manager.close(payload.sessionId, "capture-failed");
        throw error;
      }
    }
    if (action === "session-call") {
      const [step] = await normalizeInteractionSteps([{ tool: payload.tool, arguments: payload.arguments }], {
        actionLevel: payload.actionLevel,
        commitIntent: payload.commitIntent,
        allowMutations: payload.allowMutations === true,
        lookup
      });
      const metadata = manager.metadata(payload.sessionId);
      const startedAt = Date.now();
      try {
        if (metadata.authenticated && step.arguments.url !== undefined) assertResourceUrl(step.arguments.url, metadata.resourceId);
        const client = { call: (operation, args) => manager.execute(payload.sessionId, operation, args, { signal }) };
        const permission = await authorizeAction({ client, ...step, args: step.arguments });
        const rawText = await manager.execute(payload.sessionId, step.tool, step.arguments, { signal });
        const maxOutputBytes = normalizeMaxOutputBytes(payload.maxOutputBytes ?? config.MAX_OUTPUT_BYTES);
        const bounded = boundUtf8(rawText, maxOutputBytes);
        const finalUrl = await finalPublicUrl(payload.sessionId, signal);
        if (metadata.authenticated && finalUrl) assertResourceUrl(finalUrl, metadata.resourceId);
        return {
          sessionId: payload.sessionId,
          tool: step.tool,
          permission,
          text: bounded.text,
          finalUrl,
          elapsedMs: Date.now() - startedAt,
          truncated: bounded.truncated,
          bytes: bounded.bytes
        };
      } catch (error) {
        if (manager.has(payload.sessionId)) await manager.close(payload.sessionId, "unsafe-or-failed-navigation");
        throw error;
      }
    }
    if (action === "session-probe") {
      await manager.execute(payload.sessionId, "goto", { url: healthUrl }, { signal });
      const text = await manager.execute(payload.sessionId, "extract", { schema: healthSchema }, { signal });
      if (!text.includes('"health":"healthy"')) throw new Error("Lightpanda session probe returned unexpected content.");
      return { sessionId: payload.sessionId, text };
    }
    throw new Error(`Unsupported Lightpanda daemon action: ${action || "(empty)"}`);
  }

  async function healthCheck() {
    const client = await (createClient || (() => createStartedClient(binary, config)))();
    try {
      await client.call("goto", { url: healthUrl });
      const content = String(await client.call("extract", { schema: healthSchema })).trim();
      if (!content.includes('"health":"healthy"')) throw new Error(`Unexpected Lightpanda health content: ${content || "(empty)"}`);
      return { message: `Lightpanda MCP navigation, DOM, and extraction are healthy; ${manager.list().length} temporary session(s) active` };
    } finally {
      await Promise.resolve(client.close?.()).catch(() => {});
    }
  }

  async function close(reason = "shutdown") {
    const closed = await manager.closeAll(reason);
    if (tmpDir) await cleanupStaleCaptures(tmpDir, { olderThanMs: 0 });
    return closed;
  }

  return { manager, processJob, healthCheck, close };
}
