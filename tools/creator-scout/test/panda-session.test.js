import test from "node:test";
import assert from "node:assert/strict";
import { pandaSignedIn, revealPandaEmailControls, submitPandaSearch } from "../panda-session.js";

test("authenticated status is checked in one bounded session batch", async () => {
  const calls = [];
  const session = {
    async batch(steps, permission) {
      calls.push({ steps, permission });
      return [{ text: "" }, { text: "42 [i] button 'Sign out'" }];
    }
  };
  assert.equal(await pandaSignedIn(session), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].steps.map((step) => step.tool), ["goto", "tree"]);
});

test("auth verification waits past a signed-out loading shell", async () => {
  let calls = 0;
  const session = { async batch() {
    calls += 1;
    if (calls === 1) return [{}, { text: "link 'Sign in' Loading your saved list..." }];
    if (calls === 2) return [{ text: "link 'Sign in' Loading..." }];
    return [{ text: "button 'Sign out'" }];
  } };
  assert.equal(await pandaSignedIn(session, { pause: async () => {} }), true);
  assert.equal(calls, 3);
});

test("unresolved page hydration is not reported as missing authentication", async () => {
  let calls = 0;
  const session = { async batch() { calls += 1; return [{ text: "Loading..." }, { text: "Loading..." }]; } };
  await assert.rejects(pandaSignedIn(session, { pause: async () => {} }), /inconclusive/);
  assert.equal(calls, 11);
});

test("a fully rendered login requirement remains an auth block", async () => {
  const session = { async batch() { return [{}, { text: "heading 'Sign in to view saved creators'" }]; } };
  assert.equal(await pandaSignedIn(session), false);
});

test("search submission, polling, and result extraction share one daemon job", async () => {
  const calls = [];
  const session = {
    async batch(steps, permission) {
      calls.push({ steps, permission });
      return [
        { text: "" },
        { text: "" },
        { text: "120 heading '1 creators who cover games like Late Shift'" },
        { text: '[{"backendNodeId":10,"name":"Open channel"}]' }
      ];
    }
  };
  const output = await submitPandaSearch(session, { query: "Late Shift", timeoutMs: 30_000 });
  assert.match(output.tree, /Late Shift/);
  assert.equal(output.elements[0].backendNodeId, 10);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].steps.map((step) => step.tool), ["fill", "click", "tree", "interactiveElements"]);
  assert.equal(calls[0].steps[2].repeatUntilIncludes, "creators who cover games like");
  assert.equal(calls[0].permission.actionLevel, "commit");
});

test("email reveals and refreshed results share one bounded session batch", async () => {
  const calls = [];
  const session = {
    async batch(steps, permission) {
      calls.push({ steps, permission });
      return [
        { text: "" },
        { text: "" },
        { text: "updated result tree" },
        { text: "[]" }
      ];
    }
  };
  const output = await revealPandaEmailControls(session, [11, 22]);
  assert.equal(output.tree, "updated result tree");
  assert.deepEqual(calls[0].steps.map((step) => step.tool), ["click", "click", "tree", "interactiveElements"]);
  assert.equal(calls[0].steps[0].waitAfterMs, 2_500);
  assert.equal(calls.length, 1);
});
