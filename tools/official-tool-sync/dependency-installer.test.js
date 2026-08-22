import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installStagedDependencies } from "./dependency-installer.js";

function runCommand(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.npm_config_allow_scripts;
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} failed (${signal || code}): ${stderr || stdout}`));
    });
  });
}

async function exists(target) {
  return access(target).then(() => true, () => false);
}

async function workspaceFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "official-sync-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stageDir = path.join(root, "staging", "tool");
  const dependencyDir = path.join(root, "fixture-dependency");
  await mkdir(stageDir, { recursive: true });
  await mkdir(path.join(root, "packages", "member"), { recursive: true });
  await mkdir(dependencyDir, { recursive: true });
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }), "utf8");
  await writeFile(path.join(root, "packages", "member", "package.json"), JSON.stringify({ name: "workspace-member", version: "1.0.0" }), "utf8");
  await writeFile(path.join(dependencyDir, "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0", main: "index.js" }), "utf8");
  await writeFile(path.join(dependencyDir, "index.js"), "module.exports = true;\n", "utf8");
  await runCommand("npm", ["pack", dependencyDir, "--pack-destination", stageDir], { cwd: root, timeoutMs: 30000 });
  await writeFile(path.join(stageDir, "package.json"), JSON.stringify({
    name: "staged-tool",
    version: "1.0.0",
    dependencies: { "fixture-dependency": "file:fixture-dependency-1.0.0.tgz" }
  }), "utf8");
  return { root, stageDir };
}

for (const manager of ["pnpm", "npm"]) {
  test(`${manager} stages dependencies inside a package nested below a workspace`, async (t) => {
    const { root, stageDir } = await workspaceFixture(t);
    let attempts = 0;
    const result = await installStagedDependencies(stageDir, {
      managers: [manager],
      runCommand: async (...args) => {
        attempts += 1;
        return runCommand(...args);
      }
    });
    assert.equal(result.manager, manager);
    assert.equal(attempts, 1);
    assert.deepEqual(result.verifiedRuntimeDependencies, ["fixture-dependency"]);
    assert.equal(await exists(path.join(stageDir, "node_modules", "fixture-dependency")), true);
    assert.equal(await exists(path.join(root, "node_modules")), false);
  });
}

test("a zero-exit install without staged dependencies is rejected before fallback", async (t) => {
  const { stageDir } = await workspaceFixture(t);
  const commands = [];
  const result = await installStagedDependencies(stageDir, {
    runCommand: async (command, args) => {
      commands.push([command, ...args]);
      if (command === "npm") {
        const installed = path.join(stageDir, "node_modules", "fixture-dependency");
        await mkdir(installed, { recursive: true });
        await writeFile(path.join(installed, "package.json"), "{}", "utf8");
      }
    }
  });
  assert.equal(result.manager, "npm");
  assert.match(result.fallbackFrom, /completed without staging runtime dependencies/);
  assert.deepEqual(commands, [
    ["pnpm", "install", "--lockfile=false", "--ignore-workspace"],
    ["npm", "install", "--no-package-lock", "--workspaces=false"]
  ]);
});
