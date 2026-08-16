import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";

const execFileAsync = promisify(execFile);
const toolDir = path.resolve(import.meta.dirname, "..");
const packageDir = process.env.ARISA_PACKAGE_DIR || path.resolve(toolDir, "..", "..", "package");

async function runRequest(home, file, args) {
  await writeFile(file, `${JSON.stringify({ chatId: "123", args })}\n`, "utf8");
  const { stdout } = await execFileAsync(process.execPath, ["index.js", "run", "--request-file", file], {
    cwd: toolDir,
    env: { ...process.env, ARISA_HOME: home, ARISA_PACKAGE_DIR: packageDir }
  });
  return JSON.parse(stdout);
}

test("add-contact leaves an existing canonical email unchanged by default", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pr-campaign-dedupe-"));
  const requestFile = path.join(home, "request.json");
  try {
    const initial = await runRequest(home, requestFile, {
      action: "add-contact",
      email: "first.last@gmail.com",
      name: "Original",
      outlet: "Original outlet"
    });
    assert.equal(initial.ok, true);
    const stateFile = path.join(home, "chats", "123", "state", "tools", "pr-campaign", "campaign.json");
    const before = await readFile(stateFile, "utf8");

    const duplicate = await runRequest(home, requestFile, {
      action: "add-contact",
      email: "First.Last+press@googlemail.com",
      name: "Replacement",
      outlet: "Replacement outlet"
    });
    assert.equal(duplicate.output.text.includes('"duplicate": true'), true);
    assert.equal(duplicate.output.text.includes('"mutated": false'), true);
    assert.equal(await readFile(stateFile, "utf8"), before);

    const sameDomain = await runRequest(home, requestFile, {
      action: "add-contact",
      email: "different@gmail.com",
      name: "Different person",
      outlet: "Original outlet"
    });
    assert.equal(sameDomain.output.text.includes('"reason": "same-domain-contact"'), true);
    assert.equal(sameDomain.output.text.includes('"mutated": false'), true);
    assert.equal(await readFile(stateFile, "utf8"), before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
