import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  chatsDir,
  createIpcSocketPath,
  createPrimeDaemonSocketPath,
  getChatArtifactsDir,
  getChatConversationHistoryFile,
  getChatToolConfigPath,
  getChatToolStateDir,
  getToolStateDir,
  harnessTransitionsFile,
  primeRuntimesDir,
  runtimesDir,
  stateDir
} from "../src/runtime/paths.js";

const execFileAsync = promisify(execFile);

test("keeps chat artifact paths scoped below the chat directory", () => {
  const artifactsDir = getChatArtifactsDir("chat-1");

  assert.equal(artifactsDir, path.join(chatsDir, "chat-1", "artifacts"));
});

test("keeps portable conversation history scoped below the chat state directory", () => {
  assert.equal(
    getChatConversationHistoryFile("chat-1"),
    path.join(chatsDir, "chat-1", "state", "conversation.jsonl")
  );
});

test("keeps chat tool state and config paths scoped below the chat directory for normal names", () => {
  assert.equal(
    getChatToolStateDir("chat-1", "strudel-agent"),
    path.join(chatsDir, "chat-1", "state", "tools", "strudel-agent")
  );
  assert.equal(
    getChatToolConfigPath("chat-1", "strudel-agent"),
    path.join(chatsDir, "chat-1", "config", "tools", "strudel-agent", "config.js")
  );
});

test("documents current traversal behavior for unsanitized tool names", () => {
  const expectedRoot = path.join(chatsDir, "chat-1", "state", "tools");
  const traversed = getChatToolStateDir("chat-1", "../../evil");

  assert.equal(path.resolve(traversed), path.join(chatsDir, "chat-1", "evil"));
  assert.equal(path.resolve(traversed).startsWith(`${expectedRoot}${path.sep}`), false);
});

test("documents current traversal behavior for global tool state paths", () => {
  const expectedRoot = path.join(stateDir, "tools");
  const traversed = getToolStateDir("../../evil");

  assert.equal(path.resolve(traversed), path.join(path.dirname(stateDir), "evil"));
  assert.equal(path.resolve(traversed).startsWith(`${expectedRoot}${path.sep}`), false);
});

test("creates POSIX IPC socket paths under the state directory", () => {
  const socketPath = createIpcSocketPath({
    homeDir: "/tmp/arisa-home",
    platform: "darwin"
  });

  assert.equal(socketPath, path.join("/tmp/arisa-home", "state", "arisa.sock"));
});

test("isolates the Prime daemon socket by Arisa home", () => {
  assert.equal(
    createPrimeDaemonSocketPath({ homeDir: "/tmp/arisa-home", platform: "darwin" }),
    path.join("/tmp/arisa-home", "state", "prime-agent", "daemon.sock")
  );
  assert.match(
    createPrimeDaemonSocketPath({ homeDir: "C:\\arisa-home", platform: "win32" }),
    /^\\\\\.\\pipe\\arisa-prime-[a-f0-9]{16}$/
  );
});

test("keeps managed agent runtimes separate from mutable agent state", () => {
  assert.equal(primeRuntimesDir, path.join(runtimesDir, "prime-agent"));
  assert.equal(runtimesDir, path.join(path.dirname(stateDir), "runtimes"));
  assert.equal(harnessTransitionsFile, path.join(stateDir, "harness-transitions.jsonl"));
});

test("uses ARISA_HOME for instance-scoped paths", async (t) => {
  const customHome = await mkdtemp(path.join(os.tmpdir(), "arisa-home-"));
  t.after(() => rm(customHome, { recursive: true, force: true }));

  const script = `
const paths = await import(${JSON.stringify(new URL("../src/runtime/paths.js", import.meta.url).href)});
process.stdout.write(JSON.stringify({
  arisaHomeDir: paths.arisaHomeDir,
  configFile: paths.configFile,
  piAuthFile: paths.piAuthFile,
  harnessTransitionsFile: paths.harnessTransitionsFile,
  primeDaemonSocketFile: paths.primeDaemonSocketFile,
  primeSupervisorRegistryDir: paths.primeSupervisorRegistryDir
}));
`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, ARISA_HOME: customHome }
  });
  const paths = JSON.parse(stdout);

  assert.equal(paths.arisaHomeDir, path.resolve(customHome));
  assert.equal(paths.configFile, path.join(customHome, "state", "config.json"));
  assert.equal(paths.piAuthFile, path.join(customHome, "state", "pi-auth.json"));
  assert.equal(paths.harnessTransitionsFile, path.join(customHome, "state", "harness-transitions.jsonl"));
  assert.equal(paths.primeDaemonSocketFile, path.join(customHome, "state", "prime-agent", "daemon.sock"));
  assert.equal(paths.primeSupervisorRegistryDir, path.join(customHome, "state", "prime-agent", "supervisor-owners"));
});
