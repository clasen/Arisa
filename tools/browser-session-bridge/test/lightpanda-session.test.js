import test from "node:test";
import assert from "node:assert/strict";
import { openWithLightpanda } from "../lightpanda-session.js";

function fakeArisa(responses) {
  const calls = [];
  return {
    calls,
    tools: {
      async run(request) {
        calls.push(request);
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
      }
    }
  };
}

test("bridge open reuses bounded authenticated Lightpanda sessions", async () => {
  const arisa = fakeArisa([
    { ok: true, output: { json: { id: "lp_test", reused: true } } },
    { ok: true, output: { text: "Navigated", json: { finalUrl: "https://example.com/account" } } },
    { ok: true, output: { text: JSON.stringify({ title: "Account", text: "signed in" }), json: { finalUrl: "https://example.com/account" } } }
  ]);
  const output = await openWithLightpanda({ arisa, resourceId: "example.com", url: "https://example.com/account", maxChars: 5_000 });
  assert.deepEqual(output, {
    engine: "lightpanda",
    resourceId: "example.com",
    sessionId: "lp_test",
    reused: true,
    url: "https://example.com/account",
    title: "Account",
    text: "signed in"
  });
  assert.deepEqual(arisa.calls.map((call) => [call.name, call.args.action, call.args.tool]), [
    ["lightpanda-browser", "session-open-authenticated", undefined],
    ["lightpanda-browser", "session-call", "goto"],
    ["lightpanda-browser", "session-call", "extract"]
  ]);
});

test("bridge Lightpanda open rejects cross-site URLs before invoking a tool", async () => {
  const arisa = fakeArisa([]);
  await assert.rejects(
    openWithLightpanda({ arisa, resourceId: "example.com", url: "https://example.net/account" }),
    /outside the stored session scope/
  );
  assert.equal(arisa.calls.length, 0);
});

test("bridge Lightpanda failures remain explicit without Chromium fallback", async () => {
  const arisa = fakeArisa([
    { ok: true, output: { json: { id: "lp_test" } } },
    { ok: false, error: "target incompatible" }
  ]);
  await assert.rejects(
    openWithLightpanda({ arisa, resourceId: "example.com", url: "https://example.com/account" }),
    /target incompatible/
  );
  assert.equal(arisa.calls.length, 2);
  assert.equal(arisa.calls.some((call) => call.name !== "lightpanda-browser"), false);
});
