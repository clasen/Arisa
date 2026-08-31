import assert from "node:assert/strict";
import test from "node:test";
import { temporarySiteOrigins } from "../extension/site-permissions.js";

test("requests the parent Instagram origin needed for domain-scoped authentication cookies", () => {
  assert.deepEqual(temporarySiteOrigins(new URL("https://www.instagram.com/direct/inbox/")), [
    "https://www.instagram.com/*",
    "https://*.instagram.com/*"
  ]);
});

test("does not broaden unrelated site permissions", () => {
  assert.deepEqual(temporarySiteOrigins(new URL("https://app.example.com/account")), ["https://app.example.com/*"]);
});
