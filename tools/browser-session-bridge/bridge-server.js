import crypto from "node:crypto";
import http from "node:http";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { consumePairing, decryptEnvelope, encryptEnvelope, persistSession, validateSessionPayload } from "./session-store.js";

function commonHeaders(contentType, length) {
  return {
    "Content-Type": contentType,
    "Content-Length": length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  };
}

function jsonResponse(response, status, body) {
  const encoded = status === 204 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  response.writeHead(status, commonHeaders("application/json; charset=UTF-8", encoded.length));
  response.end(encoded);
}

function connectPage(response) {
  const encoded = Buffer.from(`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Connect Arisa Session Bridge</title><style>:root{color-scheme:dark;--bg:#1f2130;--surface:#282a36;--fg:#f8f8f2;--muted:#a6add5;--line:#44475a;--purple:#bd93f9;--green:#50fa7b;--orange:#ffb86c}*{box-sizing:border-box}body{max-width:560px;margin:12vh auto;padding:24px;color:var(--fg);background:var(--bg);font:15px/1.6 "Fira Code",ui-monospace,monospace}body:before{content:"";position:fixed;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(248,248,242,.025) 0 1px,transparent 1px 3px),radial-gradient(circle at 20% 0,rgba(189,147,249,.12),transparent 28rem)}main{position:relative;border:1px solid var(--line);border-radius:7px;padding:28px;background:rgba(40,42,54,.76)}h1{margin:0 0 18px;color:var(--orange);font-size:23px;letter-spacing:-.04em}h1 span{color:var(--green)}p{margin:10px 0;color:var(--muted)}strong{color:var(--purple)}</style></head><body><main><h1>arisa<span>.session</span></h1><p>open the arisa session bridge extension in this browser profile, then choose <strong>connect this profile</strong></p><p>the setup token is temporary, single-use, and remains in this page fragment rather than server logs</p></main></body></html>`, "utf8");
  response.writeHead(200, {
    ...commonHeaders("text/html; charset=UTF-8", encoded.length),
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
  });
  response.end(encoded);
}

function reviewerPage(response) {
  const encoded = Buffer.from(`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Arisa reviewer setup</title><style>:root{color-scheme:dark}body{max-width:560px;margin:12vh auto;padding:24px;background:#1f2130;color:#f8f8f2;font:15px/1.6 ui-monospace,monospace}main{border:1px solid #44475a;border-radius:7px;padding:28px;background:#282a36}h1{color:#ffb86c}p{color:#a6add5}.ok{color:#50fa7b}.error{color:#ff5555}</style></head><body><main><h1>arisa.session reviewer</h1><p id="status">creating a temporary, single-use reviewer setup…</p></main><script>(async()=>{const status=document.querySelector('#status');try{const token=decodeURIComponent(location.hash.slice(1));if(!token)throw new Error('reviewer credential is missing');history.replaceState(null,'',location.pathname);const base=location.pathname.replace(/\/reviewer\/?$/,'');const response=await fetch(base+'/v1/reviewer-enrollment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});const result=await response.json();if(!response.ok)throw new Error(result.error||'setup failed');status.textContent='setup ready, redirecting…';status.className='ok';location.replace(result.setupUrl)}catch(error){status.textContent=error.message||String(error);status.className='error'}})()</script></body></html>`, "utf8");
  response.writeHead(200, {
    ...commonHeaders("text/html; charset=UTF-8", encoded.length),
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  response.end(encoded);
}

function privacyPolicyPage(response, { headOnly = false } = {}) {
  const encoded = Buffer.from(`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Arisa Session Bridge Privacy Policy</title><style>:root{color-scheme:dark;--bg:#1f2130;--surface:#282a36;--fg:#f8f8f2;--muted:#c5c8e6;--line:#44475a;--purple:#bd93f9;--orange:#ffb86c}*{box-sizing:border-box}body{max-width:760px;margin:48px auto;padding:24px;color:var(--fg);background:var(--bg);font:16px/1.65 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace}main{border:1px solid var(--line);border-radius:8px;padding:32px;background:var(--surface)}h1{margin-top:0;color:var(--orange);line-height:1.2}h2{margin-top:30px;color:var(--purple);font-size:19px}p,li{color:var(--muted)}strong{color:var(--fg)}a{color:var(--purple)}code{color:var(--orange)}</style></head><body><main><h1>Arisa Session Bridge Privacy Policy</h1><p><strong>Last updated:</strong> August 16, 2026</p><p>Arisa Session Bridge has one purpose: to let a user intentionally share the active site's applicable browser session with an Arisa instance they control.</p><h2>Data processed</h2><p>Only when the user chooses <strong>Send current session</strong>, the extension processes:</p><ul><li>the active site's hostname and origin</li><li>cookies applicable to that active URL</li><li>the capture time</li><li>a revocable bridge-device identifier</li></ul><p>The extension does not collect browsing history, keystrokes, form contents, or cookies for inactive sites. It requests access to the active site for this explicit action and removes that temporary access after reading the applicable cookies.</p><h2>Use, transfer, and storage</h2><p>The extension uses this data only to transfer the user-selected session to the Arisa bridge endpoint paired by that user. Session data is encrypted with AES-256-GCM before transfer. The receiving Arisa instance stores imported sessions in that user's chat-scoped state. Cookie values are not returned in Arisa tool results.</p><p>The extension stores its bridge endpoint, device identifier, and device secret locally in the dedicated browser profile. Temporary setup credentials expire, are single-use, and remain in URL fragments so browsers do not send them in HTTP requests or referrers.</p><h2>Sharing and sale</h2><p>Arisa Session Bridge does not sell user data, use it for advertising, or transfer it to unrelated third parties. Data goes only to the Arisa bridge endpoint the user explicitly paired.</p><h2>Retention and deletion</h2><p>Users can revoke the browser profile with <strong>Forget</strong>, revoke it from Arisa, delete an imported site session, or log out of the source site. The user operating the receiving Arisa instance controls server-side retention.</p><h2>Security boundary</h2><p>Sharing a browser session grants the receiving Arisa instance the access represented by that session. Users should install the extension only in a dedicated browser profile and use least-privilege accounts. The extension does not bypass login, CAPTCHA, verification, approval, or anti-bot controls.</p><h2>Contact</h2><p>Privacy questions may be submitted through the <a href="https://github.com/clasen/Arisa">official Arisa project repository</a>.</p></main></body></html>`, "utf8");
  response.writeHead(200, {
    ...commonHeaders("text/html; charset=UTF-8", encoded.length),
    "Content-Language": "en",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  });
  response.end(headOnly ? undefined : encoded);
}

async function readJsonBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function credentialFile(directory, id) {
  if (!/^[a-zA-Z0-9_-]{20,100}$/.test(String(id || ""))) throw new Error("Invalid credential identifier");
  return path.join(directory, `${id}.json`);
}

async function cleanupExpiredPairings(pairingsDir) {
  const files = await readdir(pairingsDir).catch(() => []);
  await Promise.all(files.filter((file) => /^[a-zA-Z0-9_-]{20,100}\.json$/.test(file)).map(async (file) => {
    const target = path.join(pairingsDir, file);
    try {
      const record = JSON.parse(await readFile(target, "utf8"));
      if (Date.now() >= new Date(record.expiresAt).getTime()) await rm(target, { force: true });
    } catch {
      await rm(target, { force: true });
    }
  }));
}

function encodedCode(prefix, record) {
  return `${prefix}${Buffer.from(JSON.stringify(record)).toString("base64url")}`;
}

export function createPairingCode({ endpoint, token, secret, expiresAt }) {
  return encodedCode("arisa-session://", { version: 1, endpoint, token, secret, expiresAt });
}

export async function createPairing({ pairingsDir, chatId, endpoint, ttlSeconds }) {
  await mkdir(pairingsDir, { recursive: true, mode: 0o700 });
  await cleanupExpiredPairings(pairingsDir);
  const token = crypto.randomBytes(24).toString("base64url");
  const secret = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const record = { version: 1, chatId: String(chatId), secret, createdAt: new Date().toISOString(), expiresAt };
  await writeFile(credentialFile(pairingsDir, token), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return { code: createPairingCode({ endpoint, token, secret, expiresAt }), expiresAt };
}

export async function createDevice({ enrollmentsDir, chatId, endpoint, label, ttlSeconds }) {
  await mkdir(enrollmentsDir, { recursive: true, mode: 0o700 });
  await cleanupExpiredPairings(enrollmentsDir);
  const token = crypto.randomBytes(24).toString("base64url");
  const activationSecret = crypto.randomBytes(32).toString("base64url");
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const record = {
    version: 1,
    chatId: String(chatId),
    deviceId: crypto.randomBytes(18).toString("base64url"),
    secret: crypto.randomBytes(32).toString("base64url"),
    activationSecret,
    label: String(label || "Arisa browser profile").slice(0, 80),
    createdAt,
    expiresAt
  };
  await writeFile(credentialFile(enrollmentsDir, token), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const code = encodedCode("arisa-enroll://", { version: 1, endpoint, token, activationSecret, expiresAt });
  return {
    label: record.label,
    createdAt,
    expiresAt,
    code,
    setupUrl: `${endpoint}/connect#${encodeURIComponent(code)}`
  };
}

function reviewerCredentialId(token) {
  if (!/^[a-zA-Z0-9_-]{32,100}$/.test(String(token || ""))) throw new Error("Invalid reviewer credential");
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createReviewerAccess({ reviewersDir, chatId, endpoint, label = "Chrome Web Store reviewer" }) {
  await mkdir(reviewersDir, { recursive: true, mode: 0o700 });
  const files = await readdir(reviewersDir).catch(() => []);
  await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => {
    const target = path.join(reviewersDir, file);
    try {
      const record = JSON.parse(await readFile(target, "utf8"));
      if (String(record.chatId) === String(chatId)) await rm(target, { force: true });
    } catch {}
  }));
  const token = crypto.randomBytes(32).toString("base64url");
  const id = reviewerCredentialId(token);
  const record = { version: 1, chatId: String(chatId), endpoint, label: String(label).slice(0, 80), createdAt: new Date().toISOString() };
  await writeFile(credentialFile(reviewersDir, id), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return { reviewerUrl: `${endpoint}/reviewer#${token}`, createdAt: record.createdAt, label: record.label };
}

export async function revokeReviewerAccess(reviewersDir, chatId) {
  const files = await readdir(reviewersDir).catch(() => []);
  let revoked = 0;
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const target = path.join(reviewersDir, file);
    try {
      const record = JSON.parse(await readFile(target, "utf8"));
      if (String(record.chatId) !== String(chatId)) continue;
      await rm(target, { force: true });
      revoked += 1;
    } catch {}
  }
  return revoked;
}

async function reviewerEnrollment({ reviewersDir, enrollmentsDir, token }) {
  const id = reviewerCredentialId(token);
  const record = JSON.parse(await readFile(credentialFile(reviewersDir, id), "utf8"));
  if (!record.chatId || !record.endpoint) throw new Error("Invalid reviewer credential");
  return createDevice({
    enrollmentsDir,
    chatId: record.chatId,
    endpoint: record.endpoint,
    label: record.label,
    ttlSeconds: 600
  });
}

async function consumeDeviceEnrollment(enrollmentsDir, token) {
  if (!/^[a-zA-Z0-9_-]{20,100}$/.test(String(token || ""))) throw new Error("Invalid enrollment token");
  const source = credentialFile(enrollmentsDir, token);
  const claimed = path.join(enrollmentsDir, `${token}.${crypto.randomUUID()}.processing.json`);
  await rename(source, claimed);
  try {
    const enrollment = JSON.parse(await readFile(claimed, "utf8"));
    if (Date.now() >= new Date(enrollment.expiresAt).getTime()) throw new Error("Enrollment link expired");
    return enrollment;
  } finally {
    await rm(claimed, { force: true });
  }
}

async function activateDevice({ enrollmentsDir, devicesDir, envelope }) {
  const enrollment = await consumeDeviceEnrollment(enrollmentsDir, envelope.token);
  const payload = decryptEnvelope(enrollment.activationSecret, envelope);
  if (payload?.version !== 1 || payload?.action !== "activate") throw new Error("Invalid device activation request");
  await mkdir(devicesDir, { recursive: true, mode: 0o700 });
  const record = {
    version: 1,
    deviceId: enrollment.deviceId,
    chatId: enrollment.chatId,
    secret: enrollment.secret,
    label: enrollment.label,
    createdAt: enrollment.createdAt
  };
  const file = credentialFile(devicesDir, record.deviceId);
  await writeFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return {
    response: encryptEnvelope(enrollment.activationSecret, {
      version: 1,
      deviceId: record.deviceId,
      secret: record.secret,
      label: record.label
    }),
    event: {
      chatId: record.chatId,
      deviceId: record.deviceId,
      label: record.label,
      createdAt: record.createdAt
    }
  };
}

export async function listDevices(devicesDir, chatId) {
  const files = await readdir(devicesDir).catch(() => []);
  const devices = [];
  for (const file of files.filter((name) => /^[a-zA-Z0-9_-]{20,100}\.json$/.test(name))) {
    try {
      const record = JSON.parse(await readFile(path.join(devicesDir, file), "utf8"));
      if (String(record.chatId) === String(chatId)) devices.push({ deviceId: record.deviceId, label: record.label, createdAt: record.createdAt, lastUsedAt: record.lastUsedAt || null });
    } catch {}
  }
  return devices;
}

export async function revokeDevice(devicesDir, chatId, deviceId) {
  const file = credentialFile(devicesDir, deviceId);
  const record = JSON.parse(await readFile(file, "utf8"));
  if (String(record.chatId) !== String(chatId)) throw new Error("Device does not belong to this chat");
  await rm(file, { force: true });
  return record.deviceId;
}

async function deviceCredential(devicesDir, deviceId) {
  const file = credentialFile(devicesDir, deviceId);
  const record = JSON.parse(await readFile(file, "utf8"));
  if (!record.secret || !record.chatId) throw new Error("Invalid device credential");
  return { file, record };
}

async function recordDeviceUse(file, record) {
  const updated = { ...record, lastUsedAt: new Date().toISOString() };
  await writeFile(file, `${JSON.stringify(updated)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export function startBridgeServer({ host, port, pairingsDir, enrollmentsDir, devicesDir, reviewersDir, maxBodyBytes, maxCookies, stateDirForChat, onDeviceActivated, onSessionImported }) {
  const recentDeviceUses = new Map();
  const recentReviewerUses = new Map();
  const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") return jsonResponse(response, 204, {});
    if (request.method === "GET" && request.url === "/health") return jsonResponse(response, 200, { ok: true });
    if (request.method === "GET" && request.url === "/connect") return connectPage(response);
    if (request.method === "GET" && request.url === "/reviewer") return reviewerPage(response);
    if (["GET", "HEAD"].includes(request.method) && ["/privacy", "/privacy/"].includes(request.url)) {
      return privacyPolicyPage(response, { headOnly: request.method === "HEAD" });
    }
    if (request.method !== "POST" || !["/v1/activate-device", "/v1/import", "/v1/import-device", "/v1/revoke-device", "/v1/reviewer-enrollment"].includes(request.url)) return jsonResponse(response, 404, { ok: false, error: "Not found" });

    try {
      const envelope = await readJsonBody(request, maxBodyBytes);
      if (request.url === "/v1/reviewer-enrollment") {
        const reviewerId = reviewerCredentialId(envelope.token);
        const lastUsed = recentReviewerUses.get(reviewerId) || 0;
        if (Date.now() - lastUsed < 5000) throw Object.assign(new Error("Please wait before creating another reviewer setup"), { statusCode: 429 });
        const enrollment = await reviewerEnrollment({ reviewersDir, enrollmentsDir, token: envelope.token });
        recentReviewerUses.set(reviewerId, Date.now());
        return jsonResponse(response, 200, { ok: true, setupUrl: enrollment.setupUrl, expiresAt: enrollment.expiresAt });
      }
      if (request.url === "/v1/activate-device") {
        const activated = await activateDevice({ enrollmentsDir, devicesDir, envelope });
        await onDeviceActivated?.(activated.event).catch(() => {});
        return jsonResponse(response, 200, { ok: true, ...activated.response });
      }
      let credential;
      let device = null;
      if (["/v1/import-device", "/v1/revoke-device"].includes(request.url)) {
        const lastUsed = recentDeviceUses.get(envelope.deviceId) || 0;
        if (request.url === "/v1/import-device" && Date.now() - lastUsed < 1500) throw Object.assign(new Error("Please wait before sharing again"), { statusCode: 429 });
        device = await deviceCredential(devicesDir, envelope.deviceId);
        credential = device.record;
      } else {
        credential = await consumePairing(pairingsDir, envelope.token);
      }

      const decrypted = decryptEnvelope(credential.secret, envelope);
      if (request.url === "/v1/revoke-device") {
        if (decrypted?.version !== 1 || decrypted?.action !== "revoke" || decrypted?.deviceId !== envelope.deviceId) throw new Error("Invalid revocation request");
        await rm(device.file, { force: true });
        recentDeviceUses.delete(envelope.deviceId);
        return jsonResponse(response, 200, { ok: true, revoked: envelope.deviceId });
      }

      const session = validateSessionPayload(decrypted, maxCookies);
      await persistSession(stateDirForChat(credential.chatId), session);
      if (device) {
        recentDeviceUses.set(envelope.deviceId, Date.now());
        await recordDeviceUse(device.file, device.record);
      }
      await onSessionImported?.({
        chatId: String(credential.chatId),
        deviceId: device?.record?.deviceId || null,
        label: device?.record?.label || null,
        resourceId: session.resourceId,
        sourceUrl: session.sourceUrl,
        cookieCount: session.cookies.length,
        receivedAt: session.receivedAt
      }).catch(() => {});
      return jsonResponse(response, 200, {
        ok: true,
        resourceId: session.resourceId,
        cookieCount: session.cookies.length,
        receivedAt: session.receivedAt
      });
    } catch (error) {
      return jsonResponse(response, error.statusCode || 400, { ok: false, error: error.message || "Import failed" });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

export async function probeBridge(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok || !(await response.json()).ok) throw new Error("Browser session bridge HTTP health check failed");
  return { message: "Encrypted browser session import endpoint is healthy" };
}
