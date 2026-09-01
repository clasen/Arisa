import crypto from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function decodeBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function cleanText(value, maxLength) {
  const text = String(value ?? "");
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) throw new Error("Invalid cookie field");
  return text;
}

function normalizedDomain(value) {
  return cleanText(value, 253).toLowerCase().replace(/^\./, "");
}

function cookieAppliesToHost(cookieDomain, hostname) {
  return hostname === cookieDomain || hostname.endsWith(`.${cookieDomain}`);
}

export function encryptEnvelope(secret, payload) {
  const key = decodeBase64Url(secret);
  if (key.length !== 32) throw new Error("Invalid encryption secret");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const encrypted = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return { iv: iv.toString("base64url"), ciphertext: encrypted.toString("base64url") };
}

export function decryptEnvelope(secret, envelope) {
  const key = decodeBase64Url(secret);
  const iv = decodeBase64Url(envelope?.iv);
  const encrypted = decodeBase64Url(envelope?.ciphertext);
  if (key.length !== 32 || iv.length !== 12 || encrypted.length < 17) throw new Error("Invalid encrypted payload");
  const tag = encrypted.subarray(encrypted.length - 16);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
}

function normalizedWebStorage(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const output = {};
  let bytes = 0;
  for (const area of ["local", "session"]) {
    const entries = source[area] && typeof source[area] === "object" && !Array.isArray(source[area]) ? Object.entries(source[area]) : [];
    if (entries.length > 500) throw new Error("Too many web storage entries");
    output[area] = {};
    for (const [rawKey, rawValue] of entries) {
      const key = cleanText(rawKey, 512);
      const stored = String(rawValue ?? "");
      bytes += Buffer.byteLength(key) + Buffer.byteLength(stored);
      if (stored.length > 256 * 1024 || bytes > 1024 * 1024) throw new Error("Web storage payload is too large");
      output[area][key] = stored;
    }
  }
  return output;
}

export function validateSessionPayload(payload, maxCookies = 500) {
  if (![1, 2].includes(payload?.version) || !Array.isArray(payload.cookies)) throw new Error("Unsupported session payload");
  if (payload.cookies.length > maxCookies) throw new Error("Invalid cookie count");
  const webStorage = normalizedWebStorage(payload.webStorage);
  if (!payload.cookies.length && !Object.keys(webStorage.local).length && !Object.keys(webStorage.session).length) throw new Error("The shared site has no session state");
  const source = new URL(payload.sourceUrl);
  if (!["http:", "https:"].includes(source.protocol)) throw new Error("Invalid source URL");
  const hostname = source.hostname.toLowerCase();
  if (!hostname || hostname !== String(payload.resourceId || "").toLowerCase()) throw new Error("Session identity does not match source host");

  const cookies = payload.cookies.map((cookie) => {
    const domain = normalizedDomain(cookie.domain || hostname);
    if (!cookieAppliesToHost(domain, hostname)) throw new Error("Cookie domain is outside the selected site");
    const sameSite = ["no_restriction", "lax", "strict", "unspecified"].includes(cookie.sameSite) ? cookie.sameSite : "unspecified";
    const normalized = {
      name: cleanText(cookie.name, 512),
      value: String(cookie.value ?? ""),
      domain: cookie.domain?.startsWith(".") ? `.${domain}` : domain,
      path: cleanText(cookie.path || "/", 2048),
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite,
      session: Boolean(cookie.session)
    };
    if (normalized.value.length > 8192) throw new Error("Cookie value is too large");
    if (Number.isFinite(cookie.expirationDate)) normalized.expirationDate = Number(cookie.expirationDate);
    return normalized;
  });

  return {
    version: 2,
    resourceId: hostname,
    sourceUrl: source.origin,
    capturedAt: new Date(payload.capturedAt || Date.now()).toISOString(),
    receivedAt: new Date().toISOString(),
    cookies,
    webStorage
  };
}

function extensionSameSite(value) {
  if (value === "Strict") return "strict";
  if (value === "Lax") return "lax";
  if (value === "None") return "no_restriction";
  return "unspecified";
}

export function refreshedSession(session, browserCookies, refreshedAt = new Date().toISOString()) {
  const resourceId = String(session?.resourceId || "").toLowerCase();
  const applicableCookies = (browserCookies || []).filter((cookie) => {
    try {
      return cookieAppliesToHost(normalizedDomain(cookie.domain || resourceId), resourceId);
    } catch {
      return false;
    }
  }).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: extensionSameSite(cookie.sameSite),
    session: !Number.isFinite(cookie.expires) || cookie.expires < 0,
    ...(Number.isFinite(cookie.expires) && cookie.expires >= 0 ? { expirationDate: cookie.expires } : {})
  }));
  if (!applicableCookies.length) return null;
  const normalized = validateSessionPayload({
    version: 1,
    resourceId,
    sourceUrl: session.sourceUrl,
    capturedAt: session.capturedAt,
    cookies: applicableCookies
  });
  return { ...session, cookies: normalized.cookies, refreshedAt };
}

export async function persistRefreshedSession(stateDir, session, browserCookies, sessionPath = null) {
  const refreshed = refreshedSession(session, browserCookies);
  if (!refreshed) return false;
  if (sessionPath) await persistSessionFile(sessionPath, refreshed);
  else await persistSession(stateDir, refreshed);
  return true;
}

export function refreshSessionOnBrowserClose({ browser, context, stateDir, session, sessionPath = null, shouldPersist = () => true }) {
  const closeBrowser = browser.close.bind(browser);
  let closing = null;
  browser.close = () => {
    if (!closing) {
      closing = (async () => {
        try {
          if (await shouldPersist()) await persistRefreshedSession(stateDir, session, await context.cookies(), sessionPath);
        } finally {
          await closeBrowser();
        }
      })();
    }
    return closing;
  };
}

export async function consumePairing(pairingsDir, token) {
  if (!/^[a-zA-Z0-9_-]{20,100}$/.test(String(token || ""))) throw new Error("Invalid pairing token");
  const source = path.join(pairingsDir, `${token}.json`);
  const claimed = path.join(pairingsDir, `${token}.${crypto.randomUUID()}.processing.json`);
  await rename(source, claimed);
  try {
    const pairing = JSON.parse(await readFile(claimed, "utf8"));
    if (Date.now() >= new Date(pairing.expiresAt).getTime()) throw new Error("Pairing code expired");
    return pairing;
  } finally {
    await rm(claimed, { force: true });
  }
}

async function persistSessionFile(file, session) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    return file;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function persistSession(stateDir, session) {
  return persistSessionFile(path.join(stateDir, "sessions", `${session.resourceId}.json`), session);
}

function validatedDeviceId(deviceId) {
  const id = String(deviceId || "");
  if (!/^[a-zA-Z0-9_-]{20,100}$/.test(id)) throw new Error("Invalid device identifier");
  return id;
}

export async function persistDeviceSession(stateDir, deviceId, session) {
  const id = validatedDeviceId(deviceId);
  return persistSessionFile(path.join(stateDir, "device-sessions", id, `${session.resourceId}.json`), session);
}

export async function persistDeviceSourceSession(stateDir, deviceId, session) {
  const id = validatedDeviceId(deviceId);
  return persistSessionFile(path.join(stateDir, "device-source-sessions", id, `${session.resourceId}.json`), session);
}
