import assert from "node:assert/strict";
import crypto from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  installBundledOfficialTool,
  installLockedOfficialTool,
  validateOfficialToolLock,
  verifyOfficialToolTree
} from "../src/core/tools/official-tool-installer.js";

async function digest(file) {
  return crypto.createHash("sha256").update(await readFile(file)).digest("hex");
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arisa-official-tool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source", "tools", "master-slave");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "tool.manifest.json"), `${JSON.stringify({ name: "master-slave", entry: "index.js" })}\n`);
  await writeFile(path.join(source, "index.js"), "process.stdout.write('ok');\n");
  await mkdir(path.join(source, "lib"));
  await writeFile(path.join(source, "lib", "helper.js"), "export {};\n");
  const files = {
    "index.js": await digest(path.join(source, "index.js")),
    "lib/helper.js": await digest(path.join(source, "lib", "helper.js")),
    "tool.manifest.json": await digest(path.join(source, "tool.manifest.json"))
  };
  return { root, source, files };
}

function lock(files) {
  return {
    version: 1,
    repository: "https://github.com/clasen/Arisa.git",
    commit: "a".repeat(40),
    tools: { "master-slave": { files } }
  };
}

test("requires immutable commits and exact SHA-256 entries", () => {
  assert.throws(
    () => validateOfficialToolLock({ ...lock({ "index.js": "f".repeat(64) }), commit: "main" }, "master-slave"),
    /immutable 40-character commit/
  );
  assert.throws(
    () => validateOfficialToolLock(lock({ "../index.js": "f".repeat(64) }), "master-slave"),
    /Invalid official tool file path/
  );
});

test("verifies the exact file set and digests", async (t) => {
  const { source, files } = await fixture(t);
  assert.deepEqual(await verifyOfficialToolTree(source, files), { files: 3 });
  await writeFile(path.join(source, "extra.js"), "unexpected\n");
  await assert.rejects(() => verifyOfficialToolTree(source, files), /unexpected=extra.js/);
});

test("bundled master-slave lock matches the catalog source", async () => {
  const lock = JSON.parse(await readFile(new URL("../src/official-tools.lock.json", import.meta.url), "utf8"));
  const source = fileURLToPath(new URL("../../tools/master-slave/", import.meta.url));

  assert.deepEqual(
    await verifyOfficialToolTree(source, lock.tools["master-slave"].files),
    { files: Object.keys(lock.tools["master-slave"].files).length }
  );
});

test("rejects symbolic links before deployment", async (t) => {
  const { source, files } = await fixture(t);
  await symlink(path.join(source, "index.js"), path.join(source, "link.js"));
  await assert.rejects(() => verifyOfficialToolTree(source, { ...files, "link.js": files["index.js"] }), /symbolic link/);
});

test("installs a verified staged tree without overwriting an existing tool", async (t) => {
  const { root, source, files } = await fixture(t);
  const destination = path.join(root, "installed", "master-slave");
  const checkout = async ({ checkoutDir }) => {
    await mkdir(path.join(checkoutDir, "tools"), { recursive: true });
    await cp(source, path.join(checkoutDir, "tools", "master-slave"), { recursive: true });
  };
  const result = await installLockedOfficialTool({
    toolName: "master-slave",
    lock: lock(files),
    destination,
    scratchRoot: root,
    checkout,
    validate: async () => {}
  });
  assert.equal(result.commit, "a".repeat(40));
  assert.equal(await readFile(path.join(destination, "index.js"), "utf8"), "process.stdout.write('ok');\n");
  await assert.rejects(
    () => installLockedOfficialTool({ toolName: "master-slave", lock: lock(files), destination, scratchRoot: root, checkout }),
    /Refusing to overwrite/
  );
});

test("loads the bundled lock before selecting the canonical tool destination", async (t) => {
  const { root, files } = await fixture(t);
  const lockFile = path.join(root, "official-tools.lock.json");
  await writeFile(lockFile, `${JSON.stringify(lock(files))}\n`);
  const calls = [];
  const result = await installBundledOfficialTool("master-slave", {
    lockFile,
    install: async (request) => {
      calls.push(request);
      return { installed: true };
    }
  });
  assert.deepEqual(result, { installed: true, dependencies: [] });
  assert.equal(calls[0].toolName, "master-slave");
  assert.deepEqual(calls[0].lock, lock(files));
  assert.match(calls[0].destination, /tools\/master-slave$/);
});

test("installs locked tool dependencies before the requested tool", async (t) => {
  const { root, files } = await fixture(t);
  const dependencyLock = lock(files);
  dependencyLock.tools = {
    "mcp-client": { version: "0.1.0", toolDependencies: {}, files },
    "magnific-mcp": { version: "0.1.0", toolDependencies: { "mcp-client": "^0.1.0" }, files }
  };
  const lockFile = path.join(root, "dependency-lock.json");
  await writeFile(lockFile, `${JSON.stringify(dependencyLock)}\n`);
  const calls = [];
  const result = await installBundledOfficialTool("magnific-mcp", {
    lockFile,
    resolveInstalledVersion: async () => undefined,
    install: async ({ toolName }) => {
      calls.push(toolName);
      return { toolName, installed: true };
    }
  });
  assert.deepEqual(calls, ["mcp-client", "magnific-mcp"]);
  assert.equal(result.toolName, "magnific-mcp");
  assert.deepEqual(result.dependencies, [{ name: "mcp-client", version: "0.1.0", status: "installed" }]);
});
