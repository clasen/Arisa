import test from "node:test";
import assert from "node:assert/strict";
import { draftLimit, coverageHostAllowed } from "../draft-policy.js";

test("the profile draft ceiling cannot be overridden by invocation args", () => {
  assert.equal(draftLimit({ limit: "10" }, { maxDraftsPerRun: 1 }), 1);
  assert.equal(draftLimit({ action: "draft-one", limit: 10 }, {}), 1);
  assert.equal(draftLimit({ limit: 3 }, {}), 3);
  for (const limit of [0, -1, 1.5, "invalid"]) assert.throws(() => draftLimit({ limit }, {}));
});

test("coverage hosts are parsed, not matched as substrings", () => {
  const hosts = ["www.youtube.com", "youtu.be"];
  assert.equal(coverageHostAllowed("https://www.youtube.com/watch?v=test", hosts), true);
  assert.equal(coverageHostAllowed("https://youtu.be/test", hosts), true);
  for (const url of ["", "http://youtu.be/test", "https://www.youtube.com.evil.test/watch", "https://evil.test/?url=youtu.be", "https://www.youtube.com@evil.test/"]) {
    assert.equal(coverageHostAllowed(url, hosts), false);
  }
  assert.equal(coverageHostAllowed("https://example.com"), true);
});
