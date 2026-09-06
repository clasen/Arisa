import { createPiRuntime, supportsProviderOAuth } from "./pi-runtime.js";

export function createPiOAuthLogin({ provider, onAuth, onDeviceCode, onPrompt, onProgress, onSelect } = {}) {
  let resolveManualCode;
  const manualCodePromise = new Promise((resolve) => {
    resolveManualCode = resolve;
  });

  const controller = {
    provider,
    manualInputRequested: false,
    submitManualCode(value) {
      if (!resolveManualCode) return false;
      controller.manualInputRequested = false;
      resolveManualCode(String(value || "").trim());
      resolveManualCode = null;
      return true;
    },
    waitForManualCode() {
      controller.manualInputRequested = true;
      return manualCodePromise;
    },
    promise: null
  };

  controller.promise = createPiRuntime().then(async (runtime) => {
    if (!supportsProviderOAuth(provider, runtime)) {
      throw new Error(`No internal OAuth login flow is available for ${provider}.`);
    }
    let notifications = Promise.resolve();
    let notificationError;
    const credential = await runtime.login(provider, "oauth", {
      notify(event) {
        notifications = notifications.then(async () => {
          if (event.type === "auth_url") await onAuth?.({ ...event, controller });
          else if (event.type === "device_code") await onDeviceCode?.({ ...event, controller });
          else await onProgress?.(event.message);
        }).catch((error) => { notificationError = error; });
      },
      async prompt(params) {
        await notifications;
        if (notificationError) throw notificationError;
        if (params.type === "select") {
          return onSelect ? onSelect({ ...params, controller }) : params.options?.[0]?.id;
        }
        if (params.type === "manual_code") return controller.waitForManualCode();
        return onPrompt ? onPrompt({ ...params, controller }) : "";
      }
    });
    await notifications;
    if (notificationError) throw notificationError;
    return credential;
  }).finally(() => {
    controller.submitManualCode("");
  });

  return controller;
}
