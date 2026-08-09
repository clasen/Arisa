import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultPrimeVersion } from "../src/core/config/config-defaults.js";
import {
  getManagedPrimePaths,
  installManagedPrimeAgent,
  parsePrimeChecksumManifest,
  resolvePrimeAgentRuntime,
  validatePrimeKernel
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

test("installs the current Prime release beside the previous managed version and reuses it", async (t) => {
  const runtimesRoot = await mkdtemp(path.join(os.tmpdir(), "arisa-prime-runtimes-"));
  t.after(() => rm(runtimesRoot, { recursive: true, force: true }));
  const tarball = Buffer.from("verified Prime Agent tarball");
  const checksum = crypto.createHash("sha256").update(tarball).digest("hex");
  const fetched = [];
  let installCount = 0;
  let kernelValidationCount = 0;
  const kernelVenvDir = path.join(runtimesRoot, "kernel-venv");
  const previousPaths = getManagedPrimePaths("0.7.0", { runtimesRoot });
  await mkdir(path.dirname(previousPaths.cliPath), { recursive: true });
  await writeFile(previousPaths.cliPath, "#!/usr/bin/env node\n", "utf8");
  await writeFile(previousPaths.markerFile, `${JSON.stringify({
    version: "0.7.0",
    installerSchema: 2,
    kernelVenvDir
  })}\n`, "utf8");

  const fetchImpl = async (url) => {
    fetched.push(url);
    if (url.endsWith("/SHA256SUMS")) {
      return new Response(`${checksum}  prime-agent-${defaultPrimeVersion}.tgz\n`);
    }
    return new Response(tarball);
  };
  const spawnImpl = (_command, args, options) => successfulChild(async () => {
    installCount += 1;
    assert.equal(options.env.PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL, "1");
    assert.equal(options.env.PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL, "1");
    assert.equal(options.env.PRIME_AGENT_INSTALL_UV, "1");
    assert.equal(options.env.PRIME_AGENT_KERNEL_VENV, kernelVenvDir);
    const prefixIndex = args.indexOf("--prefix");
    assert.notEqual(prefixIndex, -1);
    const stagingDir = args[prefixIndex + 1];
    const cliPath = path.join(stagingDir, "node_modules", "prime-agent", "dist", "bundle", "cli.js");
    await mkdir(path.dirname(cliPath), { recursive: true });
    await writeFile(cliPath, "#!/usr/bin/env node\n", "utf8");
  });
  const validateImpl = async ({ command, commandArgs, expectedVersion }) => {
    assert.equal(command, process.execPath);
    assert.equal(expectedVersion, defaultPrimeVersion);
    await access(commandArgs[0]);
    return { command, version: expectedVersion };
  };
  const validateKernelImpl = async ({ kernelVenvDir: receivedKernelVenvDir }) => {
    kernelValidationCount += 1;
    assert.equal(receivedKernelVenvDir, kernelVenvDir);
  };

  const installed = await installManagedPrimeAgent({
    version: defaultPrimeVersion,
    baseUrl: "https://releases.example.test",
    runtimesRoot,
    kernelVenvDir,
    fetchImpl,
    spawnImpl,
    validateImpl,
    validateKernelImpl
  });
  const paths = getManagedPrimePaths(defaultPrimeVersion, { runtimesRoot });
  assert.equal(installed.command, process.execPath);
  assert.deepEqual(installed.commandArgs, [paths.cliPath]);
  assert.equal(installed.managed, true);
  assert.equal(installed.kernelVenvDir, kernelVenvDir);
  assert.equal(installCount, 1);
  assert.equal(kernelValidationCount, 1);
  assert.deepEqual(fetched, [
    `https://releases.example.test/releases/v${defaultPrimeVersion}/SHA256SUMS`,
    `https://releases.example.test/releases/v${defaultPrimeVersion}/prime-agent-${defaultPrimeVersion}.tgz`
  ]);
  const marker = JSON.parse(await readFile(paths.markerFile, "utf8"));
  assert.equal(marker.version, defaultPrimeVersion);
  assert.equal(marker.installerSchema, 2);
  assert.equal(marker.kernelVenvDir, kernelVenvDir);
  assert.equal(marker.sha256, checksum);
  await access(paths.cliPath);
  await access(path.join(paths.runtimeDir, `prime-agent-${defaultPrimeVersion}.tgz`));
  await access(previousPaths.cliPath);

  const reused = await installManagedPrimeAgent({
    version: defaultPrimeVersion,
    baseUrl: "https://releases.example.test",
    runtimesRoot,
    kernelVenvDir,
    fetchImpl: async () => { throw new Error("must not fetch"); },
    spawnImpl: () => { throw new Error("must not install"); },
    validateImpl,
    validateKernelImpl
  });
  assert.deepEqual(reused.commandArgs, [paths.cliPath]);
  assert.equal(installCount, 1);

  delete marker.installerSchema;
  await writeFile(paths.markerFile, `${JSON.stringify(marker)}\n`, "utf8");
  await installManagedPrimeAgent({
    version: defaultPrimeVersion,
    baseUrl: "https://releases.example.test",
    runtimesRoot,
    kernelVenvDir,
    fetchImpl,
    spawnImpl,
    validateImpl,
    validateKernelImpl
  });
  assert.equal(installCount, 2);
  assert.equal(kernelValidationCount, 2);
});

test("validates the persistent Prime IPython kernel", async () => {
  const kernelVenvDir = path.join(os.tmpdir(), "arisa-kernel-validation");
  const result = await validatePrimeKernel({
    kernelVenvDir,
    spawnImpl: (command, args, options) => {
      assert.equal(command, path.join(kernelVenvDir, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python"));
      assert.match(args[1], /import IPython; import ipykernel/);
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("9.0.0\n"));
        child.emit("close", 0);
      });
      return child;
    }
  });

  assert.equal(result.kernelVenvDir, kernelVenvDir);
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
