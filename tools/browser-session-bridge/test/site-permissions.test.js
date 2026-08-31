import assert from "node:assert/strict";
import test from "node:test";
import { relatedCookieUrls, temporarySiteOrigins } from "../extension/site-permissions.js";

test("requests the parent Instagram origin needed for domain-scoped authentication cookies", () => {
  assert.deepEqual(temporarySiteOrigins(new URL("https://www.instagram.com/direct/inbox/")), [
    "https://www.instagram.com/*",
    "https://*.instagram.com/*"
  ]);
});

test("captures only the related Google Accounts cookie scope for the Chrome Web Store", () => {
  assert.deepEqual(relatedCookieUrls(new URL("https://chrome.google.com/webstore/devconsole/")).map(String), ["https://accounts.google.com/"]);
  assert.deepEqual(relatedCookieUrls(new URL("https://mail.google.com/")), []);
});

test("does not broaden unrelated site permissions", () => {
  assert.deepEqual(temporarySiteOrigins(new URL("https://app.example.com/account")), ["https://app.example.com/*"]);
});
