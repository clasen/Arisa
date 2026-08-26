import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { piAuthFile } from "../../platform/paths.js";

export function createPiOAuthLogin({ provider, onAuth, onDeviceCode, onPrompt, onProgress, onSelect } = {}) {
  const authStorage = AuthStorage.create(piAuthFile);
  const oauthProvider = authStorage.getOAuthProviders().find((item) => item.id === provider);
  if (!oauthProvider) {
    throw new Error(`No internal OAuth login flow is available for ${provider}.`);
  }

  let resolveManualCode;
  const manualCodePromise = new Promise((resolve) => {
    resolveManualCode = resolve;
  });

  const controller = {
    provider,
    oauthProvider,
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

  controller.promise = authStorage.login(provider, {
    onAuth: async (params) => {
      await onAuth?.({ ...params, controller });
    },
    onDeviceCode: async (params) => {
      await onDeviceCode?.({ ...params, controller });
    },
    onPrompt: async (params) => {
      if (!onPrompt) return "";
      return onPrompt({ ...params, controller });
    },
    onProgress: (message) => {
      onProgress?.(message);
    },
    onSelect: async (params) => {
      if (!onSelect) return params.options?.[0]?.id;
      return onSelect({ ...params, controller });
    },
    onManualCodeInput: () => controller.waitForManualCode()
  }).finally(() => {
    controller.submitManualCode("");
  });

  return controller;
}
