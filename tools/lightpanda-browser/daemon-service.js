import { authorizeAction, readTools } from "./action-policy.js";
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

function hasWebStorage(webStorage) {
  return Object.keys(webStorage?.local || {}).length > 0 || Object.keys(webStorage?.session || {}).length > 0;
}

function batchControl(raw = {}) {
  const repeatUntilIncludes = String(raw.repeatUntilIncludes || "").trim();
  if (repeatUntilIncludes.length > 200) throw new Error("repeatUntilIncludes is too long.");
  return {
    includeOutput: raw.includeOutput !== false,
    repeatUntilIncludes,
    intervalMs: boundedInteger(raw.intervalMs, 1_000, 100, 5_000),
    timeoutMs: boundedInteger(raw.timeoutMs, 15_000, 500, 60_000),
    waitAfterMs: boundedInteger(raw.waitAfterMs, 0, 0, 5_000),
    maxOutputBytes: raw.maxOutputBytes
  };
}

async function pause(ms, signal) {
  if (!ms) return;
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Lightpanda session batch was cancelled."), { code: "DAEMON_JOB_CANCELLED" }));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function finalUrlFromClient(client, lookup) {
  try {
    const current = String(await client.call("getUrl", {})).trim();
    return current ? (await validatePublicUrl(current, lookup ? { lookup } : undefined)).href : null;
  } catch (error) {
    if (/FrameNotLoaded|no page is loaded/i.test(error.message || "")) return null;
    throw error;
  }
}

function storageInjectionScript(origin, webStorage) {
  return `return (() => {\n  if (location.origin !== ${JSON.stringify(origin)}) throw new Error("Storage origin mismatch");\n  const data = ${JSON.stringify(webStorage)};\n  for (const [key, value] of Object.entries(data.local || {})) localStorage.setItem(key, value);\n  for (const [key, value] of Object.entries(data.session || {})) sessionStorage.setItem(key, value);\n  return true;\n})()`;
}

const storageSnapshotScript = `return {\n  origin: location.origin,\n  local: Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => { const key = localStorage.key(index); return [key, localStorage.getItem(key)]; })),\n  session: Object.fromEntries(Array.from({ length: sessionStorage.length }, (_, index) => { const key = sessionStorage.key(index); return [key, sessionStorage.getItem(key)]; }))\n}`;

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
  const baseCall = client.call.bind(client);
  const baseClose = client.close.bind(client);
  try {
    await client.start();
    if (profile) {
      let storageInjected = !hasWebStorage(profile.webStorage);
      client.call = async (tool, args = {}) => {
        if (tool === "goto" && !storageInjected) {
          const target = new URL(String(args.url || ""));
          await baseCall("goto", args);
          await baseCall("evaluate", { script: storageInjectionScript(target.origin, profile.webStorage) });
          storageInjected = true;
          return baseCall("goto", args);
        }
        return baseCall(tool, args);
      };
      client.close = async () => {
        let webStorage = null;
        try {
          if (!client.failed) {
            const snapshot = JSON.parse(await baseCall("evaluate", { script: storageSnapshotScript }));
            assertResourceUrl(snapshot.origin, profile.resourceId);
            webStorage = { local: snapshot.local, session: snapshot.session };
          }
        } catch {}
        try {
          await baseClose();
          await profile.finish({ refresh: true, webStorage });
        } catch (error) {
          await profile.finish({ refresh: false }).catch(() => {});
          throw error;
        }
      };
    }
    return client;
  } catch (error) {
    await baseClose().catch(() => {});
    await profile?.finish({ refresh: false }).catch(() => {});
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
      const reused = manager.reuseByResource(payload.resourceId);
      if (reused) return reused;
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
      let operationCompleted = false;
      try {
        if (metadata.authenticated && step.arguments.url !== undefined) assertResourceUrl(step.arguments.url, metadata.resourceId);
        const client = { call: (operation, args) => manager.execute(payload.sessionId, operation, args, { signal }) };
        const permission = await authorizeAction({ client, ...step, args: step.arguments });
        const rawText = await manager.execute(payload.sessionId, step.tool, step.arguments, { signal });
        operationCompleted = true;
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
        if (operationCompleted && manager.has(payload.sessionId)) await manager.close(payload.sessionId, "unsafe-final-navigation");
        throw error;
      }
    }
    if (action === "session-batch") {
      const rawSteps = payload.steps;
      const steps = await normalizeInteractionSteps(rawSteps, {
        actionLevel: payload.actionLevel,
        commitIntent: payload.commitIntent,
        allowMutations: payload.allowMutations === true,
        lookup
      });
      const controls = rawSteps.map(batchControl);
      for (const [index, control] of controls.entries()) {
        if (control.repeatUntilIncludes && !readTools.has(steps[index].tool)) {
          throw new Error(`repeatUntilIncludes is allowed only on read operations; step ${index + 1} uses ${steps[index].tool}.`);
        }
      }
      const metadata = manager.metadata(payload.sessionId);
      const totalOutputLimit = normalizeMaxOutputBytes(payload.maxOutputBytes ?? config.MAX_OUTPUT_BYTES);
      const startedAt = Date.now();
      return manager.executeWith(payload.sessionId, async (client) => {
        const outputs = [];
        let remainingOutputBytes = totalOutputLimit;
        for (const [index, step] of steps.entries()) {
          const control = controls[index];
          const stepStartedAt = Date.now();
          if (metadata.authenticated && step.arguments.url !== undefined) assertResourceUrl(step.arguments.url, metadata.resourceId);
          const permission = await authorizeAction({ client, ...step, args: step.arguments });
          const deadline = Date.now() + control.timeoutMs;
          let rawText = "";
          let attempts = 0;
          do {
            rawText = await client.call(step.tool, step.arguments);
            attempts += 1;
            if (!control.repeatUntilIncludes || rawText.toLowerCase().includes(control.repeatUntilIncludes.toLowerCase())) break;
            if (Date.now() + control.intervalMs > deadline) {
              throw Object.assign(new Error(`Lightpanda batch step ${index + 1} did not reach its expected text.`), {
                code: "LIGHTPANDA_BATCH_CONDITION_TIMEOUT",
                recoverable: true
              });
            }
            await pause(control.intervalMs, signal);
          } while (true);
          let bounded = { text: "", bytes: 0, truncated: false };
          if (control.includeOutput && remainingOutputBytes >= 1_024) {
            const stepLimit = Math.min(
              remainingOutputBytes,
              normalizeMaxOutputBytes(control.maxOutputBytes, remainingOutputBytes)
            );
            bounded = boundUtf8(rawText, stepLimit);
            remainingOutputBytes -= bounded.bytes;
          }
          outputs.push({
            index: index + 1,
            tool: step.tool,
            permission,
            attempts,
            elapsedMs: Date.now() - stepStartedAt,
            text: bounded.text,
            bytes: bounded.bytes,
            truncated: bounded.truncated,
            outputIncluded: control.includeOutput
          });
          await pause(control.waitAfterMs, signal);
        }
        const finalUrl = await finalUrlFromClient(client, lookup);
        if (metadata.authenticated && finalUrl) assertResourceUrl(finalUrl, metadata.resourceId);
        return {
          sessionId: payload.sessionId,
          text: `Completed ${outputs.length} Lightpanda session operations in one bounded batch.`,
          finalUrl,
          elapsedMs: Date.now() - startedAt,
          operations: outputs.length,
          bytes: totalOutputLimit - remainingOutputBytes,
          steps: outputs
        };
      }, { signal });
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
