#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import defaults from "./config.js";
import { createSecureFetch, validateRemoteUrl } from "./network-security.js";
import { discoverOAuth, pollDeviceAuthorization, startDeviceAuthorization, validAccessToken } from "./oauth-device.js";
import { oauthWatchTasks } from "./oauth-watch-plan.js";
import { callMcpTool, listMcpTools } from "./mcp-session.js";
import { availableTools, remoteArguments, resolveRemoteTool } from "./tool-routing.js";
import { normalizeProfileName, openCredentials, readState, sealCredentials, writeState } from "./state-store.js";

const TOOL_NAME = "mcp-client";
const importCore = (relativePath) => import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, "src", relativePath)).href);

function usage() {
  return `mcp-client

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions via args.action:
  register    Save a chat-scoped HTTPS MCP endpoint. args: profile, endpoint
  profiles    List profiles without credentials
  probe       Read OAuth discovery metadata. args: profile
  oauth-start Start OAuth device authorization. args: profile
  oauth-poll  Check a pending device authorization. args: profile
  oauth-watch Internal one-shot OAuth watcher that reschedules only while pending
  tools       Connect and list MCP tools and schemas. args: profile
  call        Call one MCP tool. Requires confirm=true. args: profile, tool, arguments, confirm
  <tool name> Call a discovered MCP tool directly. Requires profile and confirm=true
  remove      Delete a local profile and its encrypted credentials. args: profile

Security:
  - HTTPS public endpoints only by default
  - credentials are encrypted at rest and never returned
  - MCP calls require explicit confirmation
  - profiles and authorization are isolated by chat
`;
}

function truthy(value) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "yes";
}

function required(value, name) {
  const cleaned = String(value || "").trim();
  if (!cleaned) throw new Error(`${name} is required`);
  return cleaned;
}

function profileSummary(name, profile) {
  return {
    name,
    endpoint: profile.endpoint,
    createdAt: profile.createdAt,
    authenticated: Boolean(profile.authenticatedAt),
    authenticatedAt: profile.authenticatedAt || null,
    authorizationPending: Boolean(profile.authorizationPendingAt)
  };
}

function profileFor(state, value) {
  const name = normalizeProfileName(value);
  const profile = state.profiles[name];
  if (!profile) throw new Error(`Unknown MCP profile: ${name}`);
  return { name, profile };
}

async function saveCredentials(globalStateDir, stateDir, state, name, profile, credentials, status = {}) {
  const sealedCredentials = await sealCredentials(globalStateDir, credentials);
  state.profiles[name] = { ...profile, sealedCredentials, ...status };
  await writeState(stateDir, state);
  return state.profiles[name];
}

function publicOAuthMetadata(resource, metadata) {
  return {
    resource: resource.resource || null,
    authorizationServers: resource.authorization_servers || [],
    scopes: resource.scopes_supported || metadata.scopes_supported || [],
    supportsDeviceAuthorization: Boolean(metadata.device_authorization_endpoint),
    supportsDynamicRegistration: Boolean(metadata.registration_endpoint),
    issuer: metadata.issuer || null
  };
}

function compactResult(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(compactResult);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "data" && typeof item === "string" && item.length > 512) output[key] = `[base64 omitted: ${item.length} characters]`;
    else output[key] = compactResult(item);
  }
  return output;
}

function extensionFor(mimeType) {
  return new Map([
    ["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/webp", ".webp"], ["image/gif", ".gif"],
    ["audio/mpeg", ".mp3"], ["audio/ogg", ".ogg"], ["audio/wav", ".wav"], ["audio/mp4", ".m4a"],
    ["video/mp4", ".mp4"], ["video/webm", ".webm"], ["video/quicktime", ".mov"], ["application/pdf", ".pdf"]
  ]).get(mimeType) || ".bin";
}

async function materializeBinary(result, tmpDir, maxBytes) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const item = content.find((entry) => ["image", "audio", "video"].includes(entry?.type) && typeof entry.data === "string");
  if (!item) return null;
  const bytes = Buffer.from(item.data, "base64");
  if (bytes.length > maxBytes) throw new Error(`MCP binary result exceeds the ${maxBytes}-byte limit`);
  const mimeType = item.mimeType || "application/octet-stream";
  await mkdir(tmpDir, { recursive: true });
  const fileName = `mcp-result-${Date.now()}${extensionFor(mimeType)}`;
  const filePath = path.join(tmpDir, fileName);
  await writeFile(filePath, bytes, { mode: 0o600 });
  const kind = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : mimeType.startsWith("video/") ? "video" : "document";
  return { filePath, fileName, mimeType, kind, ...(kind === "audio" ? { delivery: { method: "audio" } } : {}) };
}

async function authenticatedContext({ globalStateDir, stateDir, state, name, profile, fetchFn }) {
  let credentials = await openCredentials(globalStateDir, profile.sealedCredentials);
  const token = await validAccessToken(fetchFn, credentials);
  if (JSON.stringify(token.credentials) !== JSON.stringify(credentials)) {
    credentials = token.credentials;
    profile = await saveCredentials(globalStateDir, stateDir, state, name, profile, credentials, {
      authenticatedAt: token.accessToken ? profile.authenticatedAt : null
    });
  }
  if (!token.accessToken) throw new Error(`Profile ${name} is not authorized; run oauth-start first`);
  return { credentials, accessToken: token.accessToken, profile };
}

async function execute(request) {
  if (!process.env.ARISA_PACKAGE_DIR) throw new Error("ARISA_PACKAGE_DIR is required");
  const [{ loadToolConfig }, { toolError, toolOk }, paths] = await Promise.all([
    importCore("core/tools/tool-config.js"),
    importCore("core/tools/tool-result.js"),
    importCore("runtime/paths.js")
  ]);
  const chatId = String(request.chatId || "").trim();
  if (!chatId) return toolError("chatId is required");
  const args = request.args || {};
  const action = String(args.action || "profiles").trim().toLowerCase();
  const config = await loadToolConfig(TOOL_NAME, defaults, chatId);
  const stateDir = paths.getChatToolStateDir(chatId, TOOL_NAME);
  const globalStateDir = paths.getToolStateDir(TOOL_NAME);
  const tmpDir = paths.getChatToolTmpDir(chatId, TOOL_NAME);
  const state = await readState(stateDir);
  const security = {
    allowPrivateHosts: truthy(config.ALLOW_PRIVATE_HOSTS),
    timeoutMs: Number(config.REQUEST_TIMEOUT_MS || defaults.REQUEST_TIMEOUT_MS),
    maxResponseBytes: Number(config.MAX_RESULT_BYTES || defaults.MAX_RESULT_BYTES)
  };
  const fetchFn = createSecureFetch(security);

  if (action === "register") {
    const name = normalizeProfileName(args.profile);
    const endpoint = await validateRemoteUrl(required(args.endpoint, "endpoint"), security);
    if (state.profiles[name] && !truthy(args.replace)) return toolError(`Profile ${name} already exists; use replace=true to replace it`);
    state.profiles[name] = { endpoint: endpoint.href, createdAt: new Date().toISOString() };
    await writeState(stateDir, state);
    return toolOk({ text: `Registered MCP profile ${name}.`, json: profileSummary(name, state.profiles[name]), mimeType: "application/json" });
  }

  if (action === "profiles") {
    const profiles = Object.entries(state.profiles).map(([name, profile]) => profileSummary(name, profile));
    return toolOk({ text: `${profiles.length} MCP profile(s).`, json: { profiles }, mimeType: "application/json" });
  }

  const { name, profile: storedProfile } = profileFor(state, args.profile);
  let profile = storedProfile;
  const endpoint = await validateRemoteUrl(profile.endpoint, security);

  if (action === "probe") {
    const { resource, metadata } = await discoverOAuth(fetchFn, endpoint);
    return toolOk({ text: `MCP profile ${name} publishes OAuth metadata.`, json: publicOAuthMetadata(resource, metadata), mimeType: "application/json" });
  }

  if (action === "oauth-start") {
    const credentials = await openCredentials(globalStateDir, profile.sealedCredentials);
    const started = await startDeviceAuthorization(fetchFn, endpoint, credentials);
    const watchId = randomUUID();
    started.credentials.pending.watchId = watchId;
    profile = await saveCredentials(globalStateDir, stateDir, state, name, profile, started.credentials, {
      authorizationPendingAt: new Date().toISOString(),
      authorizationWatchId: watchId,
      authorizationNotifiedAt: null,
      authenticatedAt: null
    });
    return toolOk({
      text: `Open ${started.public.verificationUri} and enter code ${started.public.userCode}. Authorization will be detected automatically.`,
      json: { profile: name, ...started.public, watching: true },
      mimeType: "application/json"
    }, {
      status: "scheduled",
      asyncTasks: oauthWatchTasks(name, watchId, started.public.expiresAt)
    });
  }

  if (action === "oauth-poll" || action === "oauth-watch") {
    const watching = action === "oauth-watch";
    const credentials = await openCredentials(globalStateDir, profile.sealedCredentials);
    if (watching && args.watchId && args.watchId !== credentials.pending?.watchId) {
      return toolOk({ json: { profile: name, skipped: "stale-watch" }, mimeType: "application/json" });
    }
    if (!credentials.pending?.deviceCode) {
      return toolOk({
        ...(watching ? {} : { text: credentials.tokens?.accessToken ? `MCP profile ${name} is authorized.` : `No OAuth authorization is pending for ${name}.` }),
        json: { profile: name, pending: false, authenticated: Boolean(credentials.tokens?.accessToken), watching },
        mimeType: "application/json"
      });
    }
    let polled;
    try {
      polled = await pollDeviceAuthorization(fetchFn, credentials);
    } catch (error) {
      if (watching && /expired/i.test(error?.message || "")) {
        await saveCredentials(globalStateDir, stateDir, state, name, profile, { ...credentials, pending: null }, {
          authorizationPendingAt: null,
          authorizationWatchId: null
        });
        return toolOk({ json: { profile: name, expired: true }, mimeType: "application/json" }, {
          asyncTask: {
            kind: "agent_event",
            payload: { prompt: `OAuth device authorization for MCP profile ${name} expired before completion. Tell the user briefly and offer to start a new authorization. Do not expose credentials.` }
          }
        });
      }
      throw error;
    }
    if (polled.pending) {
      return toolOk({
        ...(watching ? {} : { text: "OAuth authorization is still pending." }),
        json: { profile: name, pending: true, code: polled.code, watching },
        mimeType: "application/json"
      });
    }
    profile = await saveCredentials(globalStateDir, stateDir, state, name, profile, polled.credentials, {
      authorizationPendingAt: null,
      authorizationWatchId: null,
      authorizationNotifiedAt: watching ? new Date().toISOString() : profile.authorizationNotifiedAt || null,
      authenticatedAt: new Date().toISOString()
    });
    return toolOk({ text: `MCP profile ${name} is authorized.`, json: profileSummary(name, profile), mimeType: "application/json" }, watching ? {
      asyncTask: {
        kind: "agent_event",
        payload: {
          prompt: `OAuth authorization completed for MCP profile ${name}. Acknowledge completion, run mcp-client action tools for profile ${name}, inspect the exact schemas, and continue the approved specialized Magnific MCP adapter without invoking any credit-consuming remote tool.`
        }
      }
    } : {});
  }

  if (action === "remove") {
    delete state.profiles[name];
    await writeState(stateDir, state);
    return toolOk({ text: `Removed MCP profile ${name} and its local credentials.`, json: { removed: name }, mimeType: "application/json" });
  }

  const auth = await authenticatedContext({ globalStateDir, stateDir, state, name, profile, fetchFn });
  if (action === "tools") {
    const result = await listMcpTools({ endpoint, accessToken: auth.accessToken, fetchFn });
    return toolOk({ text: `${result.tools?.length || 0} MCP tool(s) available from ${name}.`, json: compactResult(result), mimeType: "application/json" });
  }

  if (!truthy(args.confirm)) return toolError("MCP tool calls require confirm=true because remote tools may consume credits or cause side effects");
  const catalog = availableTools(await listMcpTools({ endpoint, accessToken: auth.accessToken, fetchFn }));
  const tool = resolveRemoteTool(args, catalog);
  const result = await callMcpTool({ endpoint, accessToken: auth.accessToken, fetchFn }, tool, remoteArguments(args));
  const serializedSize = Buffer.byteLength(JSON.stringify(result));
  if (serializedSize > security.maxResponseBytes) throw new Error(`MCP result exceeds the ${security.maxResponseBytes}-byte limit`);
  const binary = await materializeBinary(result, tmpDir, security.maxResponseBytes);
  if (binary) return toolOk({ ...binary, text: `MCP tool ${tool} returned a ${binary.mimeType} artifact.`, json: compactResult(result) });
  return toolOk({ text: `MCP tool ${tool} completed.`, json: compactResult(result), mimeType: "application/json" });
}

async function main() {
  if (process.argv.includes("--help") || process.argv.length <= 2) return process.stdout.write(usage());
  const fileIndex = process.argv.indexOf("--request-file");
  if (process.argv[2] !== "run" || fileIndex < 0 || !process.argv[fileIndex + 1]) throw new Error("Expected run --request-file <json>");
  const request = JSON.parse(await readFile(process.argv[fileIndex + 1], "utf8"));
  const result = await execute(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, status: "failed", error: error?.message || String(error) })}\n`);
  process.exitCode = 1;
});
