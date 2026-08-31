import { pendingSetupRecord, restorableSetupCode, setupFailureKind, setupStageMessage } from "./onboarding-state.js";
import { temporarySiteOrigins } from "./site-permissions.js";
import { pendingSessionSend, shouldResumeSessionSend } from "./session-send-state.js";
import { isRestrictedScriptError } from "./restricted-pages.js";

const PENDING_SESSION_SEND_KEY = "arisaPendingSessionSend";
const PENDING_SETUP_KEY = "arisaPendingSetup";
const SETUP_FAILURE_KEY = "arisaLastSetupFailure";

const setupSection = document.querySelector("#setup");
const connectedSection = document.querySelector("#connected");
const setupCodeInput = document.querySelector("#setup-code");
const connectButton = document.querySelector("#connect");
const sendButton = document.querySelector("#send");
const forgetButton = document.querySelector("#forget");
const sitePanel = document.querySelector("#site");
const deviceLabel = document.querySelector("#device-label");
const status = document.querySelector("#status");
const setupProgress = [...document.querySelectorAll("#setup-progress li")];

let device = null;

function setSetupStage(stage) {
  const order = ["detected", "permission", "activation", "connected"];
  const current = order.indexOf(stage);
  setupProgress.forEach((item) => {
    const index = order.indexOf(item.dataset.stage);
    item.classList.toggle("done", current > index || stage === "connected");
    item.classList.toggle("current", current === index);
  });
}

function setStatus(message, kind = "") {
  status.textContent = message;
  status.className = kind;
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodedCode(raw, prefix) {
  const value = raw.trim();
  if (!value.startsWith(prefix)) return null;
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value.slice(prefix.length))));
}

function validatedEndpoint(value) {
  const endpoint = new URL(value);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname.includes("..")) {
    throw new Error("Invalid bridge endpoint");
  }
  const pathname = endpoint.pathname.replace(/\/+$/, "");
  return `${endpoint.origin}${pathname === "/" ? "" : pathname}`;
}

function parseSetupCode(raw) {
  const legacy = decodedCode(raw, "arisa-device://");
  if (legacy) {
    if (legacy.version !== 1 || !legacy.endpoint || !legacy.deviceId || !legacy.secret) throw new Error("Invalid setup code");
    return { type: "device", endpoint: validatedEndpoint(legacy.endpoint), deviceId: legacy.deviceId, secret: legacy.secret };
  }
  const enrollment = decodedCode(raw, "arisa-enroll://");
  if (!enrollment || enrollment.version !== 1 || !enrollment.endpoint || !enrollment.token || !enrollment.activationSecret || !enrollment.expiresAt) {
    throw new Error("Open a valid Arisa setup link or paste its setup code");
  }
  if (Date.now() >= new Date(enrollment.expiresAt).getTime()) throw new Error("This setup link has expired");
  return { type: "enrollment", ...enrollment, endpoint: validatedEndpoint(enrollment.endpoint) };
}

async function activeWebTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) throw new Error("The active tab has no readable URL");
  const url = new URL(tab.url);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Open an HTTP or HTTPS site first");
  return { tab, url };
}

function setupCodeFromUrl(url) {
  if (!url.hash) return "";
  const code = decodeURIComponent(url.hash.slice(1));
  if (!code.startsWith("arisa-enroll://")) return "";
  const enrollment = parseSetupCode(code);
  const endpoint = new URL(enrollment.endpoint);
  const connectPath = `${endpoint.pathname.replace(/\/+$/, "")}/connect`;
  if (endpoint.origin !== url.origin || url.pathname !== connectPath) throw new Error("Setup link and bridge endpoint do not match");
  return code;
}

function permissionPattern(endpoint) {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.hostname}/*`;
}

async function ensureEndpointPermission(endpoint) {
  const origins = [permissionPattern(endpoint)];
  if (await chrome.permissions.contains({ origins })) return;
  if (!(await chrome.permissions.request({ origins }))) throw new Error("Bridge endpoint permission was not granted");
}

async function withTemporarySitePermission(url, operation) {
  const origins = temporarySiteOrigins(url);
  const alreadyGranted = await chrome.permissions.contains({ origins });
  if (!alreadyGranted && !(await chrome.permissions.request({ origins }))) {
    throw new Error("Temporary access to the active site was not granted");
  }
  try {
    return await operation();
  } finally {
    if (!alreadyGranted) await chrome.permissions.remove({ origins }).catch(() => {});
  }
}

function showMode() {
  setupSection.classList.toggle("hidden", Boolean(device));
  connectedSection.classList.toggle("hidden", !device);
  deviceLabel.textContent = device ? new URL(device.endpoint).host : "";
}

function serializableCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    session: cookie.session,
    expirationDate: cookie.expirationDate
  };
}

async function encryptPayload(secret, payload) {
  const key = await crypto.subtle.importKey("raw", decodeBase64Url(secret), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return { iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(ciphertext) };
}

async function decryptPayload(secret, envelope) {
  const key = await crypto.subtle.importKey("raw", decodeBase64Url(secret), { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64Url(envelope.iv) },
    key,
    decodeBase64Url(envelope.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function activateEnrollment(enrollment) {
  const encrypted = await encryptPayload(enrollment.activationSecret, { version: 1, action: "activate" });
  const response = await fetch(`${enrollment.endpoint}/v1/activate-device`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: enrollment.token, ...encrypted })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `Bridge returned HTTP ${response.status}`);
  const activated = await decryptPayload(enrollment.activationSecret, result);
  if (activated.version !== 1 || !activated.deviceId || !activated.secret) throw new Error("Invalid bridge activation response");
  return { version: 1, endpoint: enrollment.endpoint, deviceId: activated.deviceId, secret: activated.secret, label: activated.label || "Arisa browser profile" };
}

async function connectProfile() {
  setStatus("");
  connectButton.disabled = true;
  let stage = "validation";
  let setup = null;
  try {
    const code = setupCodeInput.value.trim();
    setup = parseSetupCode(code);
    if (setup.type === "enrollment") {
      await chrome.storage.local.set({ [PENDING_SETUP_KEY]: pendingSetupRecord(code, setup, { resume: true }) });
    }
    stage = "permission";
    setSetupStage(stage);
    setStatus(setupStageMessage(stage));
    await ensureEndpointPermission(setup.endpoint);
    stage = "activation";
    setSetupStage(stage);
    setStatus(setupStageMessage(stage));
    device = setup.type === "enrollment" ? await activateEnrollment(setup) : setup;
    await chrome.storage.local.set({ arisaDevice: device });
    await chrome.storage.local.remove([PENDING_SETUP_KEY, SETUP_FAILURE_KEY]);
    setupCodeInput.value = "";
    setSetupStage("connected");
    showMode();
    setStatus(setupStageMessage("connected"), "success");
  } catch (error) {
    device = null;
    const kind = setupFailureKind(error, stage);
    const stored = await chrome.storage.local.get(PENDING_SETUP_KEY).catch(() => ({}));
    const pending = stored[PENDING_SETUP_KEY];
    if (pending) await chrome.storage.local.set({
      [PENDING_SETUP_KEY]: { ...pending, resume: false },
      [SETUP_FAILURE_KEY]: { version: 1, kind, stage, at: new Date().toISOString() }
    }).catch(() => {});
    setStatus(`${setupStageMessage(stage)} Failed: ${error.message || String(error)}`, "error");
  } finally {
    connectButton.disabled = false;
  }
}

async function postEncrypted(path, payload) {
  if (!device) throw new Error("This profile is not connected to Arisa");
  const encrypted = await encryptPayload(device.secret, payload);
  const response = await fetch(`${device.endpoint}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: device.deviceId, ...encrypted })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `Bridge returned HTTP ${response.status}`);
  return result;
}

async function readWebStorage(tabId) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        local: Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
          const key = localStorage.key(index);
          return [key, localStorage.getItem(key)];
        })),
        session: Object.fromEntries(Array.from({ length: sessionStorage.length }, (_, index) => {
          const key = sessionStorage.key(index);
          return [key, sessionStorage.getItem(key)];
        }))
      })
    });
    return result || { local: {}, session: {} };
  } catch (error) {
    if (isRestrictedScriptError(error)) return { local: {}, session: {} };
    throw error;
  }
}

async function sendCurrentSession() {
  setStatus("");
  sendButton.disabled = true;
  try {
    await ensureEndpointPermission(device.endpoint);
    const { tab, url } = await activeWebTab();
    await chrome.storage.local.set({ [PENDING_SESSION_SEND_KEY]: pendingSessionSend(tab, url) });
    const { cookies, webStorage } = await withTemporarySitePermission(url, async () => ({
      cookies: (await chrome.cookies.getAll({ url: url.href }))
        .filter((cookie) => !cookie.expirationDate || cookie.expirationDate * 1000 > Date.now())
        .map(serializableCookie),
      webStorage: await readWebStorage(tab.id)
    }));
    const storageCount = Object.keys(webStorage.local).length + Object.keys(webStorage.session).length;
    if (!cookies.length && !storageCount) throw new Error("No cookies or web storage are available for this site");
    const result = await postEncrypted("/v1/import-device", {
      version: 2,
      resourceId: url.hostname,
      sourceUrl: url.origin,
      capturedAt: new Date().toISOString(),
      cookies,
      webStorage
    });
    await chrome.storage.local.remove(PENDING_SESSION_SEND_KEY);
    setStatus(`Sent ${result.cookieCount} cookies and ${result.storageCount} storage entries for ${result.resourceId}.`, "success");
  } catch (error) {
    await chrome.storage.local.remove(PENDING_SESSION_SEND_KEY).catch(() => {});
    setStatus(error.message || String(error), "error");
  } finally {
    sendButton.disabled = false;
  }
}

async function forgetProfile() {
  setStatus("");
  forgetButton.disabled = true;
  try {
    if (device) await postEncrypted("/v1/revoke-device", { version: 1, action: "revoke", deviceId: device.deviceId });
  } catch (error) {
    setStatus(`Local connection removed. Server revocation failed: ${error.message || String(error)}`, "error");
  } finally {
    device = null;
    await chrome.storage.local.remove(["arisaDevice", PENDING_SESSION_SEND_KEY]);
    showMode();
    forgetButton.disabled = false;
  }
}

connectButton.addEventListener("click", connectProfile);
sendButton.addEventListener("click", sendCurrentSession);
forgetButton.addEventListener("click", forgetProfile);

async function initialize() {
  const stored = await chrome.storage.local.get(["arisaDevice", PENDING_SETUP_KEY, PENDING_SESSION_SEND_KEY]);
  device = stored.arisaDevice || null;
  showMode();
  try {
    const { tab, url } = await activeWebTab();
    sitePanel.textContent = `Current site: ${url.origin}`;
    if (device) {
      const pendingSend = stored[PENDING_SESSION_SEND_KEY];
      if (!pendingSend) return;
      if (!shouldResumeSessionSend(pendingSend, tab, url)) {
        await chrome.storage.local.remove(PENDING_SESSION_SEND_KEY);
        return;
      }
      const origins = temporarySiteOrigins(url);
      if (await chrome.permissions.contains({ origins })) {
        setStatus("Site access granted. Resuming secure session send…");
        await sendCurrentSession();
      }
      return;
    }
    const detectedCode = setupCodeFromUrl(url);
    if (detectedCode) {
      const setup = parseSetupCode(detectedCode);
      const pending = pendingSetupRecord(detectedCode, setup);
      await chrome.storage.local.set({ [PENDING_SETUP_KEY]: pending });
      setupCodeInput.value = detectedCode;
      setSetupStage("detected");
      setStatus(`${setupStageMessage("detected")} Choose Connect this profile.`, "success");
      return;
    }
    const pendingCode = restorableSetupCode(stored[PENDING_SETUP_KEY]);
    if (!pendingCode) {
      if (stored[PENDING_SETUP_KEY]) await chrome.storage.local.remove(PENDING_SETUP_KEY);
      return;
    }
    setupCodeInput.value = pendingCode;
    setSetupStage("detected");
    setStatus("Saved setup restored. Choose Connect this profile.", "success");
    if (stored[PENDING_SETUP_KEY].resume) {
      const pendingSetup = parseSetupCode(pendingCode);
      const origins = [permissionPattern(pendingSetup.endpoint)];
      if (await chrome.permissions.contains({ origins })) await connectProfile();
    }
  } catch (error) {
    if (!device) setStatus(error.message || String(error), "error");
  }
}

initialize();
