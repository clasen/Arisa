import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

test("imports grammy without the deprecated built-in punycode module", () => {
  const result = spawnSync(
    process.execPath,
    ["--trace-deprecation", "--input-type=module", "--eval", "await import('grammy')"],
    { cwd: packageDir, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /DEP0040|punycode.*deprecated/i);
});
