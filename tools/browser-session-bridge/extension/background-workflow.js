import { activateEnrollment, parseSetupCode, permissionPattern, postEncrypted } from "./bridge-client.js";
import { restorableSetupCode, setupFailureKind } from "./onboarding-state.js";
import { relatedCookieUrls, temporarySiteOrigins } from "./site-permissions.js";
import { shouldResumeSessionSend } from "./session-send-state.js";

export const SETUP = "arisaPendingSetup";
export const SEND = "arisaPendingSessionSend";
export const RESULT = "arisaOperationResult";

export function createWorkflow(api, { activate = activateEnrollment, post = postEncrypted } = {}) {
  let tail = Promise.resolve();
  const serialize = (operation) => {
    const next = tail.then(operation);
    tail = next.catch(() => {});
    return next;
  };
  const report = (text, kind = "success") => api.storage.local.set({ [RESULT]: { text, kind, at: new Date().toISOString() } });

  async function releaseSend(pending) {
    // Only remove grants acquired by this operation, never pre-existing access.
    if (pending?.ownedOrigins?.length) await api.permissions.remove({ origins: pending.ownedOrigins });
    await api.storage.local.remove(SEND);
  }

  async function connect(stored) {
    const pending = stored[SETUP];
    if (!pending) return;
    const code = restorableSetupCode(pending);
    if (!code) {
      await api.storage.local.remove(SETUP);
      return report("Setup link expired. Request a new link.", "error");
    }
    if (stored.arisaDevice) {
      await api.storage.local.remove(SETUP);
      return;
    }
    if (!pending.resume || (pending.nextAttemptAt || 0) > Date.now()) return;
    const setup = parseSetupCode(code);
    if (!await api.permissions.contains({ origins: [permissionPattern(setup.endpoint)] })) return;
    try {
      const device = await activate(setup);
      // Credential persistence precedes removing the recovery record.
      await api.storage.local.set({ arisaDevice: device });
      await api.storage.local.remove([SETUP, "arisaLastSetupFailure"]);
      await report("Profile connected. Open a logged-in site and press Send current session.");
    } catch (error) {
      const kind = setupFailureKind(error, "activation");
      const attempts = (pending.attempts || 0) + 1;
      const retryable = ["network", "activation"].includes(kind) && attempts < 3;
      await api.storage.local.set({
        [SETUP]: { ...pending, attempts, resume: retryable, nextAttemptAt: Date.now() + 60000 },
        arisaLastSetupFailure: { kind, stage: "activation", at: new Date().toISOString() }
      });
      await report(retryable ? "Connection interrupted. Background recovery will retry." : "Connection failed. Reopen the extension to retry or request a new setup link.", "error");
    }
  }

  async function capture(url) {
    const cookies = (await api.cookies.getAll({ url: url.href }))
      .filter((c) => !c.expirationDate || c.expirationDate * 1000 > Date.now())
      .map(({ name, value, domain, path, secure, httpOnly, sameSite, session, expirationDate }) => ({ name, value, domain, path, secure, httpOnly, sameSite, session, expirationDate }));
    if (!cookies.length) throw new Error(`No applicable cookies are available for ${url.hostname}`);
    return { url, cookies };
  }

  async function send(stored) {
    const pending = stored[SEND];
    if (!pending) return;
    let tab;
    let url = null;
    try {
      tab = await api.tabs.get(pending.tabId);
      if (tab?.url) url = new URL(tab.url);
    } catch {}
    if (!url || !stored.arisaDevice || pending.deviceId !== stored.arisaDevice.deviceId || !shouldResumeSessionSend(pending, tab, url)) {
      await releaseSend(pending);
      return report("Pending session share expired or its tab changed. Choose Send current session again.", "error");
    }
    if (!await api.permissions.contains({ origins: temporarySiteOrigins(url) })) return;
    try {
      const captures = [];
      for (const source of [url, ...relatedCookieUrls(url)]) captures.push(await capture(source));
      // Grants are no longer needed after capture, even if the network stalls.
      if (pending.ownedOrigins?.length) await api.permissions.remove({ origins: pending.ownedOrigins });
      const results = [];
      for (const item of captures) {
        const result = await post(stored.arisaDevice, "/v1/import-device", {
          version: 2, operationId: `${pending.operationId}:${item.url.hostname}`,
          resourceId: item.url.hostname, sourceUrl: item.url.origin,
          capturedAt: pending.createdAt, cookies: item.cookies, webStorage: { local: {}, session: {} }
        });
        results.push(result.resourceId);
        await report(`Session received for ${results.join(" and ")}. Target access is not validated yet.`);
      }
    } catch (error) {
      // An uncertain transfer is never silently replayed with a new operation id.
      await report(`Session share did not finish: ${error.message}. Check received sessions before retrying.`, "error");
    } finally {
      await releaseSend(pending);
    }
  }

  async function resume() {
    await connect(await api.storage.local.get([SETUP, "arisaDevice"]));
    await send(await api.storage.local.get([SEND, "arisaDevice"]));
  }

  async function forget() {
    const stored = await api.storage.local.get(["arisaDevice", SEND]);
    // Cancel authorized-but-pending work even if remote revocation fails.
    await releaseSend(stored[SEND]);
    await api.storage.local.remove(SETUP);
    if (stored.arisaDevice) {
      try {
        await post(stored.arisaDevice, "/v1/revoke-device", { version: 1, action: "revoke", deviceId: stored.arisaDevice.deviceId });
      } catch {
        await report("Server revocation was not confirmed. Connection kept so you can retry Forget.", "error");
        return;
      }
    }
    await api.storage.local.remove(["arisaDevice", SETUP, "arisaLastSetupFailure"]);
    await report("Browser profile revoked and local connection removed.");
  }

  return {
    resume: () => serialize(resume),
    forget: () => serialize(forget),
    cancelSend: () => serialize(async () => releaseSend((await api.storage.local.get(SEND))[SEND]))
  };
}
