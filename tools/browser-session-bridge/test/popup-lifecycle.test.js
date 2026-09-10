import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createDevice, startBridgeServer } from "../bridge-server.js";

test("Chromium worker finishes activation after the extension page closes (permission API stubbed)", { skip: process.env.RUN_BROWSER_TESTS !== "1" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-popup-lifecycle-"));
  let context; let server;
  try {
    let activated;
    const activationStarted = new Promise((resolve) => { activated = resolve; });
    const enrollmentsDir = path.join(root, "enrollments");
    server = await startBridgeServer({
      host: "127.0.0.1", port: 0, enrollmentsDir,
      devicesDir: path.join(root, "devices"), pairingsDir: path.join(root, "pairings"), reviewersDir: path.join(root, "reviewers"),
      maxBodyBytes: 1048576, maxCookies: 500, stateDirForChat: () => path.join(root, "fake-chat"),
      onDeviceActivated: async () => { activated(); await new Promise((resolve) => setTimeout(resolve, 400)); }
    });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const enrollment = await createDevice({ enrollmentsDir, chatId: "test", endpoint, label: "Lifecycle test", ttlSeconds: 600 });
    const extension = fileURLToPath(new URL("../extension", import.meta.url));
    context = await chromium.launchPersistentContext(path.join(root, "browser"), {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-sandbox"]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
    await worker.evaluate(() => { chrome.permissions.contains = async () => true; });
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    await page.evaluate(() => { chrome.permissions.request = async () => true; });
    await page.locator("#setup-code").fill(enrollment.code);
    await page.locator("#connect").click();
    await Promise.race([activationStarted, new Promise((_, reject) => setTimeout(() => reject(new Error("Activation did not start")), 10000))]);
    await page.close();
    let device;
    for (let attempt = 0; attempt < 50; attempt++) {
      device = await worker.evaluate(async () => (await chrome.storage.local.get("arisaDevice")).arisaDevice);
      if (device) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(device?.endpoint, endpoint);
    assert.equal(await worker.evaluate(async () => Boolean((await chrome.storage.local.get("arisaPendingSetup")).arisaPendingSetup)), false);
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${id}/popup.html`);
    await reopened.locator("#connected:not(.hidden)").waitFor();
  } finally {
    await context?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
