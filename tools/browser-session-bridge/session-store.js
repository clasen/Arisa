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

export function validateSessionPayload(payload, maxCookies = 500) {
  if (payload?.version !== 1 || !Array.isArray(payload.cookies)) throw new Error("Unsupported session payload");
  if (payload.cookies.length < 1 || payload.cookies.length > maxCookies) throw new Error("Invalid cookie count");
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
    version: 1,
    resourceId: hostname,
    sourceUrl: source.origin,
    capturedAt: new Date(payload.capturedAt || Date.now()).toISOString(),
    receivedAt: new Date().toISOString(),
    cookies
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

export async function persistSession(stateDir, session) {
  const sessionsDir = path.join(stateDir, "sessions");
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const file = path.join(sessionsDir, `${session.resourceId}.json`);
  await writeFile(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}
