import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  chatsDir,
  createIpcSocketPath,
  getChatArtifactsDir,
  getChatToolConfigPath,
  getChatToolStateDir,
  getToolStateDir,
  stateDir
} from "../src/runtime/paths.js";

test("keeps chat artifact paths scoped below the chat directory", () => {
  const artifactsDir = getChatArtifactsDir("chat-1");

  assert.equal(artifactsDir, path.join(chatsDir, "chat-1", "artifacts"));
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
