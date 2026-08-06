import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getManagedPrimePaths,
  installManagedPrimeAgent,
  parsePrimeChecksumManifest,
  resolvePrimeAgentRuntime
} from "../src/runtime/prime-agent-installer.js";

function successfulChild(run) {
  const child = new EventEmitter();
  queueMicrotask(async () => {
    try {
      await run();
      child.emit("close", 0, null);
    } catch (error) {
      child.emit("error", error);
    }
  });
  return child;
}

test("parses only the checksum for the exact Prime tarball", () => {
  const manifest = [
    `${"a".repeat(64)}  prime-agent-core-0.7.0.tgz`,
    `${"b".repeat(64)}  prime-agent-0.7.0.tgz`
  ].join("\n");

  assert.equal(parsePrimeChecksumManifest(manifest, "prime-agent-0.7.0.tgz"), "b".repeat(64));
  assert.throws(() => parsePrimeChecksumManifest(manifest, "../prime-agent-0.7.0.tgz"), /Invalid Prime Agent tarball name/);
  assert.throws(() => parsePrimeChecksumManifest(manifest, "prime-agent-0.8.0.tgz"), /checksum not found/);
  assert.throws(() => getManagedPrimePaths("."), /Invalid Prime Agent version/);
  assert.throws(() => getManagedPrimePaths("../0.7.0"), /Invalid Prime Agent version/);
});

test("installs a verified Prime release privately and reuses it", async (t) => {
  const runtimesRoot = await mkdtemp(path.join(os.tmpdir(), "arisa-prime-runtimes-"));
  t.after(() => rm(runtimesRoot, { recursive: true, force: true }));
  const tarball = Buffer.from("verified Prime Agent tarball");
  const checksum = crypto.createHash("sha256").update(tarball).digest("hex");
  const fetched = [];
  let installCount = 0;

  const fetchImpl = async (url) => {
    fetched.push(url);
    if (url.endsWith("/SHA256SUMS")) {
      return new Response(`${checksum}  prime-agent-0.7.0.tgz\n`);
    }
    return new Response(tarball);
  };
  const spawnImpl = (_command, args) => successfulChild(async () => {
    installCount += 1;
    const prefixIndex = args.indexOf("--prefix");
    assert.notEqual(prefixIndex, -1);
    const stagingDir = args[prefixIndex + 1];
    const cliPath = path.join(stagingDir, "node_modules", "prime-agent", "dist", "bundle", "cli.js");
    await mkdir(path.dirname(cliPath), { recursive: true });
    await writeFile(cliPath, "#!/usr/bin/env node\n", "utf8");
  });
  const validateImpl = async ({ command, commandArgs, expectedVersion }) => {
    assert.equal(command, process.execPath);
    assert.equal(expectedVersion, "0.7.0");
    await access(commandArgs[0]);
    return { command, version: expectedVersion };
  };

  const installed = await installManagedPrimeAgent({
    version: "0.7.0",
    baseUrl: "https://releases.example.test",
    runtimesRoot,
    fetchImpl,
    spawnImpl,
    validateImpl
  });
  const paths = getManagedPrimePaths("0.7.0", { runtimesRoot });
  assert.equal(installed.command, process.execPath);
  assert.deepEqual(installed.commandArgs, [paths.cliPath]);
  assert.equal(installed.managed, true);
  assert.equal(installCount, 1);
  assert.deepEqual(fetched, [
    "https://releases.example.test/releases/v0.7.0/SHA256SUMS",
    "https://releases.example.test/releases/v0.7.0/prime-agent-0.7.0.tgz"
  ]);
  const marker = JSON.parse(await readFile(paths.markerFile, "utf8"));
  assert.equal(marker.version, "0.7.0");
  assert.equal(marker.sha256, checksum);
  await access(paths.cliPath);
  await access(path.join(paths.runtimeDir, "prime-agent-0.7.0.tgz"));

  const reused = await installManagedPrimeAgent({
    version: "0.7.0",
    baseUrl: "https://releases.example.test",
    runtimesRoot,
    fetchImpl: async () => { throw new Error("must not fetch"); },
    spawnImpl: () => { throw new Error("must not install"); },
    validateImpl
  });
  assert.deepEqual(reused.commandArgs, [paths.cliPath]);
  assert.equal(installCount, 1);
});

test("rejects a release whose tarball does not match the official manifest entry", async (t) => {
  const runtimesRoot = await mkdtemp(path.join(os.tmpdir(), "arisa-prime-checksum-"));
  t.after(() => rm(runtimesRoot, { recursive: true, force: true }));
  const fetchImpl = async (url) => url.endsWith("/SHA256SUMS")
    ? new Response(`${"0".repeat(64)}  prime-agent-0.7.0.tgz\n`)
    : new Response("tampered");

  await assert.rejects(installManagedPrimeAgent({
    version: "0.7.0",
    baseUrl: "https://releases.example.test",
    runtimesRoot,
    fetchImpl,
    spawnImpl: () => { throw new Error("npm must not run"); }
  }), /checksum mismatch/);
  await assert.rejects(access(getManagedPrimePaths("0.7.0", { runtimesRoot }).runtimeDir));
});

test("keeps an explicitly configured Prime command external", async () => {
  const runtime = await resolvePrimeAgentRuntime({
    command: "/opt/prime/bin/prime-agent",
    version: "0.7.0",
    fetchImpl: async () => { throw new Error("must not fetch"); }
  });

  assert.deepEqual(runtime, {
    command: "/opt/prime/bin/prime-agent",
    commandArgs: [],
    managed: false,
    runtimeDir: "",
    version: "0.7.0"
  });
});
