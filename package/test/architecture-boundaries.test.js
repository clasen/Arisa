import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = path.join(packageDir, "src", "core");

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(target);
    return entry.isFile() && entry.name.endsWith(".js") ? [target] : [];
  }));
  return nested.flat();
}

test("core does not depend on the runtime composition layer", async () => {
  const violations = [];
  for (const file of await javascriptFiles(coreDir)) {
    const source = await readFile(file, "utf8");
    if (/from\s+["'][^"']*\/runtime\//.test(source)) {
      violations.push(path.relative(packageDir, file));
    }
  }
  assert.deepEqual(violations, []);
});
