export function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function validatedEndpoint(value) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error("Bridge endpoints require HTTPS (HTTP is allowed only on localhost)");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function permissionPattern(endpoint) {
  const url = new URL(validatedEndpoint(endpoint));
  return `${url.protocol}//${url.hostname}/*`;
}

export function parseSetupCode(raw) {
  const code = String(raw || "").trim();
  if (!code.startsWith("arisa-enroll://") || code.length > 4096) throw new Error("Open a valid Arisa setup link or paste its setup code");
  const setup = JSON.parse(new TextDecoder().decode(decodeBase64Url(code.slice("arisa-enroll://".length))));
  if (setup.version !== 1 || !/^[a-zA-Z0-9_-]{20,100}$/.test(setup.token || "") || decodeBase64Url(setup.activationSecret || "").length !== 32) throw new Error("Invalid setup code");
  const expires = Date.parse(setup.expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error("This setup link has expired");
  return { ...setup, type: "enrollment", endpoint: validatedEndpoint(setup.endpoint) };
}

export function setupCodeFromUrl(url) {
  if (!url.hash) return "";
  const code = decodeURIComponent(url.hash.slice(1));
  if (!code.startsWith("arisa-enroll://")) return "";
  const setup = parseSetupCode(code);
  const endpoint = new URL(setup.endpoint);
  if (endpoint.origin !== url.origin || url.pathname !== `${endpoint.pathname.replace(/\/+$/, "")}/connect`) throw new Error("Setup link and bridge endpoint do not match");
  return code;
}

export async function encryptPayload(secret, payload) {
  const key = await crypto.subtle.importKey("raw", decodeBase64Url(secret), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload))));
  // Avoid spreading a large cookie payload onto the JavaScript stack.
  let binary = "";
  for (const byte of encrypted) binary += String.fromCharCode(byte);
  return { iv: encodeBase64Url(iv), ciphertext: btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
}

export async function decryptPayload(secret, envelope) {
  const key = await crypto.subtle.importKey("raw", decodeBase64Url(secret), "AES-GCM", false, ["decrypt"]);
  const decoded = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64Url(envelope.iv) }, key, decodeBase64Url(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(decoded));
}

export async function postJson(endpoint, route, body) {
  const response = await fetch(`${validatedEndpoint(endpoint)}${route}`, {
    method: "POST", redirect: "error", credentials: "omit",
    signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `Bridge returned HTTP ${response.status}`);
  return result;
}

export async function activateEnrollment(setup) {
  const envelope = await encryptPayload(setup.activationSecret, { version: 1, action: "activate" });
  const response = await postJson(setup.endpoint, "/v1/activate-device", { token: setup.token, ...envelope });
  const device = await decryptPayload(setup.activationSecret, response);
  if (device.version !== 1 || !/^[a-zA-Z0-9_-]{20,100}$/.test(device.deviceId || "") || decodeBase64Url(device.secret || "").length !== 32) throw new Error("Invalid bridge activation response");
  return { ...device, endpoint: setup.endpoint };
}

export async function postEncrypted(device, route, payload) {
  if (!device) throw new Error("This profile is not connected to Arisa");
  return postJson(device.endpoint, route, { deviceId: device.deviceId, ...await encryptPayload(device.secret, payload) });
}
