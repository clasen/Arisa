import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = process.env.ARISA_PACKAGE_DIR || (await readFile(path.join(os.homedir(), ".arisa", "arisa-package-dir"), "utf8")).trim();

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || stdout)));
  });
}

test("returns a timestamped JPEG with timing metadata", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "video-analyze-test-"));
  const source = path.join(scratch, "source.mp4");
  const requestFile = path.join(scratch, "request.json");
  let outputPath;

  try {
    await execute("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10", "-t", "2", "-pix_fmt", "yuv420p", source]);
    await writeFile(requestFile, JSON.stringify({ artifact: { path: source, mimeType: "video/mp4" }, args: { frames: 4, columns: 2, width: 160 } }));

    const result = await execute(process.execPath, [path.join(toolDir, "index.js"), "run", "--request-file", requestFile], {
      env: { ...process.env, ARISA_PACKAGE_DIR: packageDir }
    });
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    assert.equal(response.output.kind, "image");
    assert.equal(response.output.mimeType, "image/jpeg");
    assert.match(response.output.fileName, /\.jpg$/);
    assert.deepEqual(response.output.json.timestampsSeconds, [0, 0.5, 1, 1.5]);
    assert.equal(response.output.json.frames, 4);

    outputPath = response.output.filePath;
    const jpeg = await readFile(outputPath);
    assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  } finally {
    if (outputPath) await rm(outputPath, { force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});
