import crypto from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function resourceId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^(?=.{1,253}$)[a-z0-9.-]+$/.test(normalized) || normalized.includes("..")) throw new Error("A valid authenticated resourceId hostname is required.");
  return normalized;
}

function normalizedDomain(value) {
  const domain = String(value || "").trim().toLowerCase().replace(/^\./, "");
  if (!/^(?=.{1,253}$)[a-z0-9.-]+$/.test(domain) || domain.includes("..")) throw new Error("Stored session contains an invalid cookie domain.");
  return domain;
}

function domainMatches(cookieDomain, hostname) {
  return hostname === cookieDomain || hostname.endsWith(`.${cookieDomain}`);
}

function cookieKey(cookie) {
  return `${String(cookie.domain || "").toLowerCase()}\n${cookie.path || "/"}\n${cookie.name}`;
}

function validateCookies(cookies, hostname) {
  if (!Array.isArray(cookies) || !cookies.length || cookies.length > 2_000) throw new Error("Stored browser session has an invalid cookie count.");
  return cookies.map((cookie) => {
    if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) throw new Error("Stored browser session contains an invalid cookie.");
    const domain = normalizedDomain(cookie.domain || hostname);
    if (!domainMatches(domain, hostname)) throw new Error("Stored cookie is outside the authenticated resource scope.");
    const name = String(cookie.name || "");
    const value = String(cookie.value ?? "");
    const cookiePath = String(cookie.path || "/");
    if (!name || name.length > 512 || value.length > 8192 || !cookiePath.startsWith("/") || cookiePath.length > 2048) throw new Error("Stored browser session contains an invalid cookie field.");
    return {
      name,
      value,
      domain: String(cookie.domain || "").startsWith(".") ? `.${domain}` : domain,
      path: cookiePath,
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: ["strict", "lax", "no_restriction", "unspecified"].includes(cookie.sameSite) ? cookie.sameSite : "unspecified",
      session: Boolean(cookie.session),
      ...(Number.isFinite(cookie.expirationDate) ? { expirationDate: Number(cookie.expirationDate) } : {})
    };
  });
}

function toLightpandaCookie(cookie) {
  const { expirationDate, session, ...output } = cookie;
  if (Number.isFinite(expirationDate)) output.expires = expirationDate;
  return output;
}

function fromLightpandaCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: ["strict", "lax", "no_restriction", "unspecified"].includes(cookie.sameSite) ? cookie.sameSite : "unspecified",
    session: !Number.isFinite(cookie.expires),
    ...(Number.isFinite(cookie.expires) ? { expirationDate: Number(cookie.expires) } : {})
  };
}

async function atomicWriteJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function assertResourceUrl(value, rawResourceId) {
  const hostname = resourceId(rawResourceId);
  const url = new URL(String(value || ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Authenticated navigation requires a plain HTTP(S) URL.");
  const target = url.hostname.toLowerCase();
  if (target !== hostname && !target.endsWith(`.${hostname}`) && !hostname.endsWith(`.${target}`)) throw new Error("Authenticated navigation left the shared session scope.");
  return url;
}

export function createAuthenticatedProfileStore({ bridgeStateDir, tmpDir }) {
  if (!bridgeStateDir || !tmpDir) throw new Error("Authenticated Lightpanda profile paths are required.");

  async function open(rawResourceId) {
    const hostname = resourceId(rawResourceId);
    const sessionPath = path.join(bridgeStateDir, "sessions", `${hostname}.json`);
    const session = JSON.parse(await readFile(sessionPath, "utf8"));
    if (String(session.resourceId || "").toLowerCase() !== hostname) throw new Error("Stored browser session identity does not match resourceId.");
    const cookies = validateCookies(session.cookies, hostname);
    const runDir = path.join(tmpDir, "authenticated-profiles", `${hostname}-${crypto.randomUUID()}`);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await chmod(runDir, 0o700);
    const cookiePath = path.join(runDir, "cookies.json");
    const cookieJarPath = path.join(runDir, "cookie-jar.json");
    await writeFile(cookiePath, `${JSON.stringify(cookies.map(toLightpandaCookie))}\n`, { mode: 0o600 });
    await chmod(cookiePath, 0o600);
    const sourceVersion = `${session.receivedAt || ""}\n${session.refreshedAt || ""}\n${session.capturedAt || ""}`;
    let finished = false;

    async function finish({ refresh }) {
      if (finished) return;
      finished = true;
      try {
        if (refresh) {
          const jar = JSON.parse(await readFile(cookieJarPath, "utf8"));
          const refreshedCookies = validateCookies(jar.map(fromLightpandaCookie), hostname);
          const latest = JSON.parse(await readFile(sessionPath, "utf8"));
          const latestVersion = `${latest.receivedAt || ""}\n${latest.refreshedAt || ""}\n${latest.capturedAt || ""}`;
          if (latestVersion === sourceVersion) {
            const merged = new Map(validateCookies(latest.cookies, hostname).map((cookie) => [cookieKey(cookie), cookie]));
            for (const cookie of refreshedCookies) merged.set(cookieKey(cookie), cookie);
            await atomicWriteJson(sessionPath, { ...latest, cookies: [...merged.values()], refreshedAt: new Date().toISOString() });
          }
        }
      } catch (error) {
        if (refresh && error?.code !== "ENOENT") throw error;
      } finally {
        await rm(runDir, { recursive: true, force: true });
      }
    }

    return {
      resourceId: hostname,
      cookiePath,
      cookieJarPath,
      finish,
      publicMetadata: { authenticated: true, resourceId: hostname }
    };
  }

  return { open };
}
