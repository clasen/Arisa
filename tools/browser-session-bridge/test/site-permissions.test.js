import assert from "node:assert/strict";
import test from "node:test";
import { relatedCookieUrls, temporarySiteOrigins } from "../extension/site-permissions.js";

test("requests the parent Instagram origin needed for domain-scoped authentication cookies", () => {
  assert.deepEqual(temporarySiteOrigins(new URL("https://www.instagram.com/direct/inbox/")), [
    "http://www.instagram.com/*",
    "https://www.instagram.com/*",
    "http://*.instagram.com/*",
    "https://*.instagram.com/*"
  ]);
});

test("adds only Google Accounts cookies to any active Google product", () => {
  assert.deepEqual(relatedCookieUrls(new URL("https://chrome.google.com/webstore/devconsole/")).map(String), ["https://accounts.google.com/"]);
  assert.deepEqual(relatedCookieUrls(new URL("https://mail.google.com/")).map(String), ["https://accounts.google.com/"]);
  assert.deepEqual(relatedCookieUrls(new URL("https://accounts.google.com/")), []);
  assert.deepEqual(relatedCookieUrls(new URL("https://youtube.com/")), []);
});

test("requests the parent YouTube origin needed for domain-scoped authentication cookies", () => {
  assert.deepEqual(temporarySiteOrigins(new URL("https://www.youtube.com/shorts/example")), [
    "http://www.youtube.com/*",
    "https://www.youtube.com/*",
    "http://*.youtube.com/*",
    "https://*.youtube.com/*"
  ]);
});

test("does not broaden unrelated site host scope", () => {
  assert.deepEqual(temporarySiteOrigins(new URL("https://app.example.com/account")), ["http://app.example.com/*", "https://app.example.com/*"]);
});

test("requests HTTP and HTTPS for Google authentication cookies without granting all sites", () => {
  assert.deepEqual(temporarySiteOrigins(new URL("https://chrome.google.com/webstore/devconsole/")), [
    "http://chrome.google.com/*", "https://chrome.google.com/*",
    "http://*.google.com/*", "https://*.google.com/*"
  ]);
});

test("uses the same bounded grants for HTTP tabs and rejects lookalike parent domains", () => {
  assert.deepEqual(temporarySiteOrigins(new URL("http://app.example.com/")), ["http://app.example.com/*", "https://app.example.com/*"]);
  assert.deepEqual(temporarySiteOrigins(new URL("https://notgoogle.com/")), ["http://notgoogle.com/*", "https://notgoogle.com/*"]);
});
