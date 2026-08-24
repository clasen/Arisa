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
  getChatArtifactsDir,
  getChatSessionSeedFile,
  getChatTelegramWorkspacesFile,
  getChatToolConfigPath,
  getChatToolUsageFile,
  getChatToolStateDir,
  getToolStateDir,
  stateDir
} from "../src/runtime/paths.js";

const execFileAsync = promisify(execFile);

test("keeps chat artifact paths scoped below the chat directory", () => {
  const artifactsDir = getChatArtifactsDir("chat-1");

  assert.equal(artifactsDir, path.join(chatsDir, "chat-1", "artifacts"));
});

test("keeps pending session seeds scoped below the chat state directory", () => {
  assert.equal(
    getChatSessionSeedFile("chat-1"),
    path.join(chatsDir, "chat-1", "state", "session-seed.jsonl")
  );
});

test("keeps tool usage scoped below the chat state directory", () => {
  assert.equal(
    getChatToolUsageFile("chat-1"),
    path.join(chatsDir, "chat-1", "state", "tool-usage.json")
  );
});

test("keeps Telegram workspace topics scoped below the owner chat state directory", () => {
  assert.equal(
    getChatTelegramWorkspacesFile("chat-1"),
    path.join(chatsDir, "chat-1", "state", "telegram-workspaces.json")
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

test("rejects traversal and non-canonical chat tool names", () => {
  assert.throws(() => getChatToolStateDir("chat-1", "../../evil"), /Invalid tool name/);
  assert.throws(() => getChatToolConfigPath("chat-1", "Upper_Case"), /Invalid tool name/);
});

test("rejects traversal and non-canonical global tool names", () => {
  assert.throws(() => getToolStateDir("../../evil"), /Invalid tool name/);
  assert.throws(() => getToolStateDir("-invalid"), /Invalid tool name/);
});

test("creates POSIX IPC socket paths under the state directory", () => {
  const socketPath = createIpcSocketPath({
    homeDir: "/tmp/arisa-home",
    platform: "darwin"
  });

  assert.equal(socketPath, path.join("/tmp/arisa-home", "state", "arisa.sock"));
});

test("uses ARISA_HOME for instance-scoped paths", async (t) => {
  const customHome = await mkdtemp(path.join(os.tmpdir(), "arisa-home-"));
  t.after(() => rm(customHome, { recursive: true, force: true }));

  const script = `
const paths = await import(${JSON.stringify(new URL("../src/runtime/paths.js", import.meta.url).href)});
process.stdout.write(JSON.stringify({
  arisaHomeDir: paths.arisaHomeDir,
  configFile: paths.configFile,
  piAuthFile: paths.piAuthFile
}));
`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, ARISA_HOME: customHome }
  });
  const paths = JSON.parse(stdout);

  assert.equal(paths.arisaHomeDir, path.resolve(customHome));
  assert.equal(paths.configFile, path.join(customHome, "state", "config.json"));
  assert.equal(paths.piAuthFile, path.join(customHome, "state", "pi-auth.json"));
});
