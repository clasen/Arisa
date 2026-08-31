import assert from "node:assert/strict";
import test from "node:test";
import { pendingSessionSend, shouldResumeSessionSend } from "../extension/session-send-state.js";

const now = Date.parse("2026-08-31T01:00:00.000Z");
const tab = { id: 42 };
const url = new URL("https://www.instagram.com/direct/inbox/");

test("resumes an interrupted send only in the original tab and origin", () => {
  const pending = pendingSessionSend(tab, url, now);
  assert.equal(shouldResumeSessionSend(pending, tab, new URL("https://www.instagram.com/"), now + 30_000), true);
  assert.equal(shouldResumeSessionSend(pending, { id: 43 }, url, now + 30_000), false);
  assert.equal(shouldResumeSessionSend(pending, tab, new URL("https://threads.com/"), now + 30_000), false);
  assert.equal(shouldResumeSessionSend(pending, tab, url, now + 3 * 60_000), false);
});
