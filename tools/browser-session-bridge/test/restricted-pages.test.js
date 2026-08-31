import assert from "node:assert/strict";
import test from "node:test";
import { isRestrictedScriptError } from "../extension/restricted-pages.js";

test("recognizes Chrome Web Store script restrictions without hiding unrelated failures", () => {
  assert.equal(isRestrictedScriptError(new Error("The extensions gallery cannot be scripted.")), true);
  assert.equal(isRestrictedScriptError(new Error("Execution context was destroyed")), false);
});
