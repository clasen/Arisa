import { parseSetupCode, permissionPattern, setupCodeFromUrl } from "./bridge-client.js";
import { pendingSetupRecord, restorableSetupCode, setupStageMessage } from "./onboarding-state.js";
import { relatedCookieUrls, temporarySiteOrigins } from "./site-permissions.js";
import { pendingSessionSend } from "./session-send-state.js";
import { SETUP, SEND, RESULT } from "./background-workflow.js";

const $ = (id) => document.querySelector(`#${id}`);
let device = null;
let selectedTab = null;
let selectedUrl = null;
let busy = false;

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

function setSetupStage(stage) {
  const order = ["detected", "permission", "activation", "connected"];
  for (const item of document.querySelectorAll("#setup-progress li")) {
    const index = order.indexOf(item.dataset.stage);
    item.classList.toggle("done", order.indexOf(stage) > index || stage === "connected");
    item.classList.toggle("current", stage === item.dataset.stage);
  }
}

async function render() {
  const stored = await chrome.storage.local.get(["arisaDevice", SETUP, SEND, RESULT]);
  device = stored.arisaDevice || null;
  $("setup").classList.toggle("hidden", Boolean(device));
  $("connected").classList.toggle("hidden", !device);
  $("device-label").textContent = device ? new URL(device.endpoint).host : "";
  $("connect").disabled = busy || Boolean(stored[SETUP]?.resume);
  $("send").disabled = busy || Boolean(stored[SEND]) || !selectedUrl;
  $("forget").disabled = busy || Boolean(stored[SEND]);
  if (stored[RESULT]) setStatus(stored[RESULT].text, stored[RESULT].kind);
  if (device) setSetupStage("connected");
  else if (stored[SETUP]?.resume) {
    setSetupStage("activation");
    setStatus("Connection is pending in the background. You can close this popup.");
  }
}

async function background(action) {
  const result = await chrome.runtime.sendMessage({ action });
  if (!result?.ok) throw new Error(result?.error || "Background operation failed");
}

async function connectProfile() {
  if (busy) return;
  busy = true;
  let permission;
  try {
    const code = $("setup-code").value.trim();
    const setup = parseSetupCode(code);
    // Request while the user gesture is still active. Persist immediately, before
    // awaiting the prompt; storage changes and onAdded both wake the worker.
    const saved = chrome.storage.local.set({ [RESULT]: null, [SETUP]: pendingSetupRecord(code, setup, { resume: true }) });
    permission = chrome.permissions.request({ origins: [permissionPattern(setup.endpoint)] });
    permission.catch(() => {});
    await saved;
    setSetupStage("permission");
    setStatus(setupStageMessage("permission"));
    if (!await permission) {
      await chrome.storage.local.set({ [SETUP]: pendingSetupRecord(code, setup, { resume: false }) });
      throw new Error("Bridge endpoint permission was not granted");
    }
    await background("resume");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    busy = false;
    await render();
  }
}

async function sendCurrentSession() {
  if (busy || !device || !selectedUrl) return;
  busy = true;
  try {
    const origins = temporarySiteOrigins(selectedUrl);
    // Capture existing grants before the user clicks: initialize() prepares this
    // snapshot so the permission request stays within the click gesture.
    const ownedOrigins = origins.filter((origin) => !existingOrigins.has(origin));
    const saved = chrome.storage.local.set({ [RESULT]: null, [SEND]: {
      ...pendingSessionSend(selectedTab, selectedUrl), deviceId: device.deviceId,
      operationId: crypto.randomUUID(), ownedOrigins
    } });
    const permission = chrome.permissions.request({ origins });
    permission.catch(() => {});
    await saved;
    if (!await permission) {
      await background("cancel-send");
      throw new Error("Temporary site access was not granted");
    }
    await background("resume");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    busy = false;
    await refreshOrigins();
    await render();
  }
}

async function forgetProfile() {
  if (busy) return;
  busy = true;
  await render();
  try { await background("forget"); }
  catch (error) { setStatus(error.message || String(error), "error"); }
  finally { busy = false; await render(); }
}

const existingOrigins = new Set();
async function refreshOrigins() {
  existingOrigins.clear();
  if (!selectedUrl) return;
  for (const origin of temporarySiteOrigins(selectedUrl)) {
    if (await chrome.permissions.contains({ origins: [origin] })) existingOrigins.add(origin);
  }
}

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:/.test(tab.url)) {
    selectedTab = tab;
    selectedUrl = new URL(tab.url);
    $("site").textContent = `Current site: ${selectedUrl.origin}`;
    $("share-warning").textContent = relatedCookieUrls(selectedUrl).length
      ? "This shares the active site and a separate Google Accounts session. Use a dedicated browser profile."
      : "Only cookies applicable to this site are shared. Use a dedicated browser profile.";
  }
  await refreshOrigins();
  const stored = await chrome.storage.local.get(["arisaDevice", SETUP]);
  if (!stored.arisaDevice) {
    // Restore pending consent first: detecting the same link must not reset resume.
    const saved = restorableSetupCode(stored[SETUP]);
    const code = saved || (selectedUrl ? setupCodeFromUrl(selectedUrl) : "");
    if (code) {
      $("setup-code").value = code;
      if (!saved) await chrome.storage.local.set({ [SETUP]: pendingSetupRecord(code, parseSetupCode(code)) });
      setSetupStage("detected");
      setStatus("Setup link saved. Choose Connect this profile.");
    }
  }
  await render();
  background("resume").catch((error) => setStatus(error.message, "error"));
}

$("connect").addEventListener("click", connectProfile);
$("send").addEventListener("click", sendCurrentSession);
$("forget").addEventListener("click", forgetProfile);
chrome.storage.onChanged.addListener((_changes, area) => { if (area === "local") render().catch(() => {}); });
initialize().catch((error) => setStatus(error.message || String(error), "error"));
