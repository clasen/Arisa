import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import defaults from "./config.js";
import { createDevice, createPairing, createReviewerAccess, listDevices, probeBridge, revokeDevice, revokeReviewerAccess, startBridgeServer } from "./bridge-server.js";
import { createChromeWebStoreAssets, fillChromeWebStoreDistribution, fillChromeWebStoreListing, fillChromeWebStorePrivacy, fillChromeWebStorePublisherContact, fillChromeWebStoreTestInstructions, inspectChromeWebStoreDraft, replaceChromeWebStorePackage, uploadChromeWebStoreDraft, withdrawChromeWebStoreReview } from "./chrome-web-store.js";
import { openWithSession } from "./session-browser.js";

const toolName = "browser-session-bridge";
const toolDir = path.dirname(fileURLToPath(import.meta.url));

async function getArisaPackageDir() {
  if (process.env.ARISA_PACKAGE_DIR) return process.env.ARISA_PACKAGE_DIR;
  return (await readFile(path.join(os.homedir(), ".arisa", "arisa-package-dir"), "utf8")).trim();
}

async function importArisa(relativePath) {
  return import(pathToFileURL(path.join(await getArisaPackageDir(), "src", relativePath)).href);
}

const { loadToolConfig } = await importArisa("core/tools/tool-config.js");
const { createDaemonRuntime } = await importArisa("core/tools/daemon-runtime.js");
const { createArisaClient } = await importArisa("core/tools/ipc-client.js");
const { toolError, toolOk } = await importArisa("core/tools/tool-result.js");
const { getChatToolStateDir, getChatToolTmpDir } = await importArisa("runtime/paths.js");

const daemon = createDaemonRuntime({
  toolName,
  entryPath: fileURLToPath(import.meta.url),
  autoStart: true
});

function printHelp() {
  console.log(`browser-session-bridge

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions via args.action:
  setup          Create an installation-and-connection plan with a short-lived setup link. args: label?, ttlSeconds?.
  extension      Build the Chrome/Brave Manifest V3 extension zip.
  device-pair    Create a short-lived setup link for a persistent, revocable browser profile. args: label?, ttlSeconds?.
  devices        List paired browser profiles without exposing secrets.
  revoke-device  Revoke one browser profile. args: deviceId.
  reviewer-setup Create one durable, revocable Chrome Web Store reviewer setup URL.
  reviewer-revoke Revoke the Chrome Web Store reviewer setup URL.
  pair           Create a legacy encrypted one-time pairing code.
  list           List stored browser sessions without exposing cookie values.
  open                     Open one same-site URL with a stored session. args: resourceId, url, maxChars?.
  chrome-web-store-inspect      Inspect non-secret controls in one existing draft. args: draftUrl.
  chrome-web-store-fill-listing Complete and save the listing fields without submitting. args: draftUrl, description, category, language, homepageUrl, supportUrl.
  chrome-web-store-fill-privacy Complete and save accurate privacy disclosures without submitting. args: privacyUrl, privacyPolicyUrl.
  chrome-web-store-fill-distribution Save free, public, all-region distribution without submitting. args: distributionUrl.
  chrome-web-store-publisher-contact Add the publisher contact email and start verification. args: settingsUrl, contactEmail.
  chrome-web-store-upload       Upload an extension ZIP as a new draft without submitting it. ZIP artifact required; args: dashboardUrl.
  chrome-web-store-replace-package Replace a draft item's ZIP package. ZIP artifact required; args: packageUrl.
  chrome-web-store-test-instructions Save durable reviewer instructions without submitting. args: testInstructionsUrl, instructions.
  chrome-web-store-withdraw     Withdraw one pending review back to Draft. args: itemUrl.
  delete                   Delete one session. args: resourceId.

The extension shares only cookies applicable to the active tab. Setup links expire and are consumed after one successful activation.
`);
}

function arisaClient(chatId) {
  return createArisaClient({ toolName, chatId: String(chatId) });
}

async function notifyDeviceActivated(event) {
  await arisaClient(event.chatId).agent.enqueueEvent({
    resourceId: event.deviceId,
    acknowledgement: `Browser profile ${event.label} is connected. No site session has been shared yet.`,
    prompt: `Browser profile ${event.label} (${event.deviceId}) finished secure bridge authorization. This proves only that the profile is connected; it does not prove that a site session was shared or that any requested target works. The transport already acknowledged it. Continue pending setup only at the next required state.`
  });
}

async function notifySessionImported(event) {
  await arisaClient(event.chatId).agent.enqueueEvent({
    resourceId: event.resourceId,
    acknowledgement: `Session received for ${event.resourceId}. The requested target is not validated yet.`,
    prompt: `The user explicitly shared an authenticated browser session for ${event.resourceId} through ${event.label || "Arisa Session Bridge"}. The bridge received ${event.cookieCount} domain-scoped cookies at ${event.receivedAt}. This proves a session share only; it does not prove freshness, target access, or expected coverage. The transport already acknowledged it. If a pending task was waiting, run its target validation now; otherwise stay silent.`
  });
}

function positiveInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function nonNegativeInteger(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(0, parsed)) : fallback;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function normalizedEndpoint(value) {
  const endpoint = new URL(String(value || ""));
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("PUBLIC_BASE_URL must be a plain HTTP(S) origin");
  }
  const pathname = endpoint.pathname.replace(/\/+$/, "");
  return `${endpoint.origin}${pathname === "/" ? "" : pathname}`;
}

async function buildExtension(chatId) {
  const tmpDir = getChatToolTmpDir(String(chatId), toolName);
  await mkdir(tmpDir, { recursive: true });
  const outputPath = path.join(tmpDir, `arisa-session-bridge-${Date.now()}.zip`);
  const result = await runProcess("zip", ["-q", "-r", outputPath, "."], { cwd: path.join(toolDir, "extension") });
  if (result.code !== 0) throw new Error(`Could not build extension zip: ${result.stderr || result.stdout}`.trim());
  await stat(outputPath);
  return toolOk({
    text: "Chrome/Brave extension package ready",
    filePath: outputPath,
    fileName: "arisa-session-bridge.zip",
    kind: "document",
    mimeType: "application/zip"
  });
}

async function listSessions(chatId) {
  const sessionsDir = path.join(getChatToolStateDir(String(chatId), toolName), "sessions");
  const files = (await readdir(sessionsDir).catch(() => [])).filter((file) => file.endsWith(".json"));
  const sessions = [];
  for (const file of files) {
    try {
      const record = JSON.parse(await readFile(path.join(sessionsDir, file), "utf8"));
      sessions.push({
        resourceId: record.resourceId,
        sourceUrl: record.sourceUrl,
        capturedAt: record.capturedAt,
        receivedAt: record.receivedAt,
        cookieCount: Array.isArray(record.cookies) ? record.cookies.length : 0,
        connectionStatus: "session_shared",
        targetValidation: { status: "not_validated", reason: "A consumer must prove the requested target." }
      });
    } catch {}
  }
  return sessions.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
}

async function deleteSession(chatId, resourceId) {
  const normalized = String(resourceId || "").toLowerCase();
  if (!/^(?=.{1,253}$)[a-z0-9.-]+$/.test(normalized) || normalized.includes("..")) throw new Error("A valid resourceId hostname is required");
  const target = path.join(getChatToolStateDir(String(chatId), toolName), "sessions", `${normalized}.json`);
  await rm(target, { force: true });
  return normalized;
}

async function handleRequest(request) {
  const chatId = String(request.chatId || "");
  if (!chatId) throw new Error("chatId is required");
  const action = String(request.args?.action || "list");
  if (action === "extension") return buildExtension(chatId);
  if (action === "devices") {
    return toolOk({ text: "Paired browser profiles", json: { devices: await listDevices(path.join(daemon.paths.root, "devices"), chatId) }, mimeType: "application/json" });
  }
  if (action === "revoke-device") {
    const deviceId = await revokeDevice(path.join(daemon.paths.root, "devices"), chatId, request.args?.deviceId);
    return toolOk({ text: `Revoked browser profile ${deviceId}`, json: { revoked: deviceId }, mimeType: "application/json" });
  }
  if (action === "reviewer-revoke") {
    const revoked = await revokeReviewerAccess(path.join(daemon.paths.root, "reviewers"), chatId);
    return toolOk({ text: "Revoked Chrome Web Store reviewer access", json: { revoked }, mimeType: "application/json" });
  }
  if (action === "reviewer-setup") {
    const config = await loadToolConfig(toolName, defaults, chatId);
    const endpoint = normalizedEndpoint(request.args?.publicBaseUrl || config.PUBLIC_BASE_URL);
    const output = await daemon.submit({ action, chatId, endpoint, label: "Chrome Web Store reviewer" }, { timeoutMs: 15000, readyTimeoutMs: 15000 });
    return toolOk({ text: "Chrome Web Store reviewer setup is ready", json: output, mimeType: "application/json" });
  }
  if (action === "list") return toolOk({ text: "Stored browser sessions", json: { sessions: await listSessions(chatId) }, mimeType: "application/json" });
  if (action === "open") {
    const opened = await openWithSession({
      stateDir: getChatToolStateDir(chatId, toolName),
      resourceId: request.args?.resourceId,
      url: request.args?.url,
      maxChars: positiveInteger(request.args?.maxChars, 30000, 1000, 100000)
    });
    return toolOk({ text: `Page: ${opened.url}\nTitle: ${opened.title}\n\n${opened.text}`, json: opened, mimeType: "application/json" });
  }
  if (action === "chrome-web-store-publisher-contact") {
    const publisher = await fillChromeWebStorePublisherContact({
      stateDir: getChatToolStateDir(chatId, toolName),
      settingsUrl: request.args?.settingsUrl,
      contactEmail: request.args?.contactEmail
    });
    return toolOk({ text: "Chrome Web Store publisher contact email saved and verification started. The extension was not submitted for review.", json: publisher, mimeType: "application/json" });
  }
  if (action === "chrome-web-store-fill-distribution") {
    const distribution = await fillChromeWebStoreDistribution({
      stateDir: getChatToolStateDir(chatId, toolName),
      distributionUrl: request.args?.distributionUrl
    });
    return toolOk({ text: "Chrome Web Store distribution saved as a draft. It was not submitted for review.", json: distribution, mimeType: "application/json" });
  }
  if (action === "chrome-web-store-fill-privacy") {
    const privacy = await fillChromeWebStorePrivacy({
      stateDir: getChatToolStateDir(chatId, toolName),
      privacyUrl: request.args?.privacyUrl,
      fields: {
        singlePurpose: "Let a user explicitly share the active site's applicable browser session cookies with an Arisa instance they control.",
        activeTab: "Identifies the site selected by the user when they open the extension popup and choose to send that site's session.",
        cookies: "Reads only cookies applicable to the active site after the user explicitly chooses Send current session. Those cookies are encrypted before transfer to the paired Arisa bridge.",
        storage: "Stores the paired bridge endpoint and revocable device credential locally in the dedicated browser profile so the user does not need to reconnect for every session share.",
        dataTypes: ["Authentication information", "Web history"],
        privacyPolicyUrl: request.args?.privacyPolicyUrl
      }
    });
    return toolOk({ text: "Chrome Web Store privacy disclosures saved as a draft. It was not submitted for review.", json: privacy, mimeType: "application/json" });
  }
  if (action === "chrome-web-store-fill-listing") {
    const description = String(request.args?.description || "").trim();
    if (!description) throw new Error("A listing description is required");
    const assets = await createChromeWebStoreAssets({
      extensionDir: path.join(toolDir, "extension"),
      outputDir: path.join(getChatToolTmpDir(chatId, toolName), "chrome-web-store-assets")
    });
    const filled = await fillChromeWebStoreListing({
      stateDir: getChatToolStateDir(chatId, toolName),
      draftUrl: request.args?.draftUrl,
      description,
      category: request.args?.category || "Productivity",
      language: request.args?.language || "English",
      homepageUrl: request.args?.homepageUrl || "https://arisa.sh/",
      supportUrl: request.args?.supportUrl || "https://github.com/clasen/Arisa/issues",
      ...assets
    });
    return toolOk({ text: "Chrome Web Store listing saved as a draft. It was not submitted for review.", json: filled, mimeType: "application/json" });
  }
  if (action === "chrome-web-store-inspect") {
    const inspected = await inspectChromeWebStoreDraft({
      stateDir: getChatToolStateDir(chatId, toolName),
      draftUrl: request.args?.draftUrl
    });
    return toolOk({ text: "Chrome Web Store draft controls inspected", json: inspected, mimeType: "application/json" });
  }
  if (action === "chrome-web-store-test-instructions") {
    const saved = await fillChromeWebStoreTestInstructions({
      stateDir: getChatToolStateDir(chatId, toolName),
      testInstructionsUrl: request.args?.testInstructionsUrl,
      instructions: request.args?.instructions
    });
    return toolOk({ text: "Chrome Web Store reviewer instructions saved. The extension was not submitted for review.", json: saved, mimeType: "application/json" });
  }
  if (action === "chrome-web-store-replace-package") {
    if (!request.artifact?.path) throw new Error("A ZIP artifact is required");
    const replaced = await replaceChromeWebStorePackage({
      stateDir: getChatToolStateDir(chatId, toolName),
      packageUrl: request.args?.packageUrl,
      zipPath: request.artifact.path
    });
    return toolOk({ text: "Chrome Web Store draft package replaced. The extension was not submitted for review.", json: replaced, mimeType: "application/json" });
  }
  if (action === "chrome-web-store-withdraw") {
    const withdrawn = await withdrawChromeWebStoreReview({
      stateDir: getChatToolStateDir(chatId, toolName),
      itemUrl: request.args?.itemUrl
    });
    return toolOk({ text: withdrawn.withdrawn ? "Chrome Web Store review withdrawn. The item is now a draft." : "Chrome Web Store item was already a draft.", json: withdrawn, mimeType: "application/json" });
  }
  if (action === "chrome-web-store-upload") {
    if (!request.artifact?.path) throw new Error("A ZIP artifact is required");
    const uploaded = await uploadChromeWebStoreDraft({
      stateDir: getChatToolStateDir(chatId, toolName),
      dashboardUrl: request.args?.dashboardUrl,
      zipPath: request.artifact.path
    });
    return toolOk({
      text: `Chrome Web Store draft uploaded${uploaded.itemId ? `: ${uploaded.itemId}` : ""}. It was not submitted for review.`,
      json: uploaded,
      mimeType: "application/json"
    });
  }
  if (action === "delete") {
    const resourceId = await deleteSession(chatId, request.args?.resourceId);
    return toolOk({ text: `Deleted browser session ${resourceId}`, json: { deleted: resourceId }, mimeType: "application/json" });
  }
  if (["pair", "device-pair", "setup"].includes(action)) {
    const config = await loadToolConfig(toolName, defaults, chatId);
    const endpoint = normalizedEndpoint(request.args?.publicBaseUrl || config.PUBLIC_BASE_URL);
    const daemonAction = action === "setup" ? "device-pair" : action;
    const payload = daemonAction === "device-pair"
      ? { action: daemonAction, chatId, endpoint, label: request.args?.label || "Arisa browser profile", ttlSeconds: positiveInteger(request.args?.ttlSeconds || config.PAIR_TTL_SECONDS, 600, 60, 1800) }
      : { action: daemonAction, chatId, endpoint, ttlSeconds: positiveInteger(request.args?.ttlSeconds || config.PAIR_TTL_SECONDS, 600, 60, 1800) };
    const output = await daemon.submit(payload, { timeoutMs: 15000, readyTimeoutMs: 15000 });
    if (action === "setup") {
      const installUrl = String(config.CHROME_WEB_STORE_URL || "").trim() || null;
      const setup = { installUrl, setupUrl: output.setupUrl, expiresAt: output.expiresAt, fallbackAction: "extension" };
      const text = [
        installUrl ? `Install extension:\n${installUrl}` : "Chrome Web Store publication is pending; use the extension ZIP fallback.",
        `Connect this browser profile before ${output.expiresAt}:\n${output.setupUrl}`
      ].join("\n\n");
      return toolOk({ text, json: setup, mimeType: "application/json" });
    }
    const text = action === "device-pair"
      ? `Open this short-lived setup link in the dedicated Arisa browser profile, then open the extension:\n${output.setupUrl}`
      : `Pairing code (expires ${output.expiresAt}):\n${output.code}`;
    return toolOk({ text, json: output, mimeType: "application/json" });
  }
  throw new Error(`Unsupported action: ${action}`);
}

async function run(requestFile) {
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    console.log(JSON.stringify(await handleRequest(request)));
  } catch (error) {
    console.log(JSON.stringify(toolError(error?.message || String(error))));
  }
}

async function runDaemon() {
  let config = await loadToolConfig(toolName, defaults);
  const port = positiveInteger(config.PORT, 4722, 1024, 65535);
  const pairingsDir = path.join(daemon.paths.root, "pairings");
  const enrollmentsDir = path.join(daemon.paths.root, "device-enrollments");
  const devicesDir = path.join(daemon.paths.root, "devices");
  const reviewersDir = path.join(daemon.paths.root, "reviewers");
  const server = await startBridgeServer({
    host: config.LISTEN_HOST || "0.0.0.0",
    port,
    pairingsDir,
    enrollmentsDir,
    devicesDir,
    reviewersDir,
    maxBodyBytes: positiveInteger(config.MAX_BODY_BYTES, 1048576, 16384, 4194304),
    maxCookies: positiveInteger(config.MAX_COOKIES, 500, 1, 2000),
    stateDirForChat: (chatId) => getChatToolStateDir(String(chatId), toolName),
    onDeviceActivated: notifyDeviceActivated,
    onSessionImported: notifySessionImported
  });

  await daemon.workLoop({
    idleTimeoutMs: nonNegativeInteger(config.IDLE_TIMEOUT_MS, 0, 86400000),
    processJob: async (job) => {
      if (job.action === "pair") return createPairing({ pairingsDir, chatId: job.chatId, endpoint: job.endpoint, ttlSeconds: job.ttlSeconds });
      if (job.action === "device-pair") return createDevice({ enrollmentsDir, chatId: job.chatId, endpoint: job.endpoint, label: job.label, ttlSeconds: job.ttlSeconds });
      if (job.action === "reviewer-setup") return createReviewerAccess({ reviewersDir, chatId: job.chatId, endpoint: job.endpoint, label: job.label });
      throw new Error("Unsupported daemon action");
    },
    healthCheck: () => probeBridge(port),
    recover: async () => {
      config = await loadToolConfig(toolName, defaults);
      return probeBridge(port).then(() => true);
    },
    beforeExit: async () => new Promise((resolve) => server.close(resolve))
  });
}

const args = process.argv.slice(2);
if (args[0] === "daemon") await runDaemon();
else if (!args.length || args.includes("--help") || args[0] === "help") printHelp();
else if (args[0] === "run") await run(args[args.indexOf("--request-file") + 1]);
else printHelp();
