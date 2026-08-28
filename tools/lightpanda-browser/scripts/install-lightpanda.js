import crypto from "node:crypto";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { defaultBinaryPath, readBinaryVersion } from "../binary.js";

const toolName = "lightpanda-browser";
const repository = "lightpanda-io/browser";
const releaseTag = "nightly";

function coreImport(relativePath) {
  const packageDir = process.env.ARISA_PACKAGE_DIR;
  if (!packageDir) throw new Error("ARISA_PACKAGE_DIR is required.");
  return import(pathToFileURL(path.join(packageDir, "src", relativePath)).href);
}

function assetName() {
  const architecture = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  if (process.platform !== "linux" || !architecture) throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
  return `lightpanda-${architecture}-linux`;
}

async function releaseAsset() {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${releaseTag}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "arisa-lightpanda-browser-installer" }
  });
  if (!response.ok) throw new Error(`GitHub release lookup failed with status ${response.status}.`);
  const release = await response.json();
  const asset = release.assets?.find((candidate) => candidate.name === assetName());
  if (!asset?.browser_download_url || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest || "")) {
    throw new Error("The Lightpanda release asset or its SHA-256 digest is unavailable.");
  }
  return { release, asset };
}

async function downloadVerified(asset, destination) {
  const response = await fetch(asset.browser_download_url, { headers: { "user-agent": "arisa-lightpanda-browser-installer" } });
  if (!response.ok || !response.body) throw new Error(`Lightpanda download failed with status ${response.status}.`);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const observer = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), observer, createWriteStream(destination, { mode: 0o700 }));
  const digest = hash.digest("hex");
  const expected = asset.digest.slice("sha256:".length).toLowerCase();
  if (bytes !== asset.size || digest !== expected) {
    throw new Error(`Lightpanda integrity check failed (bytes ${bytes}/${asset.size}, sha256 ${digest}/${expected}).`);
  }
  return { bytes, digest };
}

async function main() {
  const { getToolStateDir } = await coreImport("runtime/paths.js");
  const stateDir = getToolStateDir(toolName);
  const binary = defaultBinaryPath(stateDir);
  const temporary = `${binary}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(binary), { recursive: true });
  try {
    const { release, asset } = await releaseAsset();
    const verified = await downloadVerified(asset, temporary);
    await chmod(temporary, 0o700);
    await rename(temporary, binary);
    const version = await readBinaryVersion(binary);
    const receipt = {
      source: `${repository}@${releaseTag}`,
      asset: asset.name,
      releaseUpdatedAt: asset.updated_at,
      bytes: verified.bytes,
      sha256: verified.digest,
      version,
      installedAt: new Date().toISOString()
    };
    await writeFile(path.join(stateDir, "installation.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    await rm(temporary, { force: true });
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
