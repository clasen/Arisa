import test from "node:test";
import assert from "node:assert/strict";
import { mergeGoogleSessionCookies, isAuthenticatedStorePage, chromeWebStoreTargetValidated } from "../google-session-policy.js";

const cookie = (value, name = "SID", domain = ".google.com") => ({ name, value, domain, path: "/" });
const snapshot = (time, cookies) => ({ receivedAt: time, cookies });
const old = "2026-09-11T13:00:00Z";
const fresh = "2026-09-11T13:30:00Z";
const url = "https://chrome.google.com/webstore/devconsole/publisher/item/edit";

test("stale account cookies cannot overwrite a refreshed store snapshot", () => {
  const primary = { ...snapshot(old, [cookie("renewed")]), refreshedAt: fresh };
  assert.equal(mergeGoogleSessionCookies(primary, [snapshot(old, [cookie("stale")])])[0].value, "renewed");
});
test("a newer account capture wins and account-only domains are preserved", () => {
  const result = mergeGoogleSessionCookies(snapshot(old, [cookie("old")]), [snapshot(fresh, [cookie("new"), cookie("account", "X", "accounts.google.com")])]);
  assert.deepEqual(result.map((c) => c.value), ["new", "account"]);
});
test("ties and unknown dates prefer the primary snapshot", () => {
  for (const time of [fresh, undefined, "invalid"]) {
    assert.equal(mergeGoogleSessionCookies(snapshot(time, [cookie("primary")]), [snapshot(time, [cookie("other")])])[0].value, "primary");
  }
});
test("removed cookies are not resurrected from an older same-domain snapshot", () => {
  assert.deepEqual(mergeGoogleSessionCookies(snapshot(fresh, [cookie("new")]), [snapshot(old, [cookie("old"), cookie("removed", "HSID")])]).map((c) => c.name), ["SID"]);
});
test("URL alone, login, empty content and lookalike hosts never validate", () => {
  for (const text of ["", "Loading", "Choose an account", "Publisher: Arisa\nSigned out"]) assert.equal(isAuthenticatedStorePage(url, text), false);
  assert.equal(isAuthenticatedStorePage("https://accounts.google.com/", "Publisher: Arisa"), false);
  assert.equal(isAuthenticatedStorePage(url.replace("chrome.google.com", "chrome.google.com.evil.test"), "Publisher: Arisa"), false);
  assert.equal(isAuthenticatedStorePage(url, "Publisher:\nArisa\nStatus: Pending review"), true);
});
test("persistence requires authenticated content on every open page", async () => {
  const page = (text) => ({ url: () => url, locator: () => ({ innerText: async () => text }) });
  assert.equal(await chromeWebStoreTargetValidated({ pages: () => [] }), false);
  assert.equal(await chromeWebStoreTargetValidated({ pages: () => [page("Publisher: Arisa")] }), true);
  assert.equal(await chromeWebStoreTargetValidated({ pages: () => [page("Publisher: Arisa"), page("Choose an account")] }), false);
});
