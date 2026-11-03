#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import defaults from "./config.js";

const TOOL_NAME = "github-ops";
if (!process.env.ARISA_PACKAGE_DIR) throw new Error("ARISA_PACKAGE_DIR is not set");
const importCore = (relativePath) => import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, "src", relativePath)).href);
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { toolError, toolNeedsConfig, toolOk } = await importCore("core/tools/tool-result.js");
const { getToolConfigPath, getChatToolConfigPath } = await importCore("runtime/paths.js");

function usage() {
  return `github-ops\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nActions via args.action:\n  status    Verify the configured token and optional repo access without printing secrets.\n  star      Star a repository as the configured GitHub user.\n  invitation Find an exact repo invitation; confirm=true accepts only that invitation.\n  checkout  Clone an exact repository into chat-scoped state; refuses existing paths.\n  sync      Authenticated fetch and fast-forward of a clean checkout; exact repo and branch required.\n\nArgs:\n  repo      Optional repo URL or owner/name. Defaults to config DEFAULT_REPO.\n\nConfig:\n  GITHUB_TOKEN   Required chat-scoped GitHub token.\n  DEFAULT_REPO   Optional default repo URL or owner/name.\n`;
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function fail(message, extra = {}) {
  printResult(toolError(message, extra));
  process.exitCode = 1;
}

function missingToken(chatId) {
  return toolNeedsConfig({
    tool: TOOL_NAME,
    missingConfig: ["GITHUB_TOKEN"],
    configPath: chatId != null ? getChatToolConfigPath(chatId, TOOL_NAME) : getToolConfigPath(TOOL_NAME),
    message: "I need a GitHub personal access token for repository operations."
  });
}

function normalizeRepo(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  const https = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\.git)?/i);
  if (https) return `${https[1]}/${https[2].replace(/\.git$/i, "")}`;
  const short = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (short) return `${short[1]}/${short[2].replace(/\.git$/i, "")}`;
  return trimmed;
}

async function githubRequest(token, apiPath, options = {}) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "arisa-github-ops",
      ...(options.headers || {})
    },
    body: options.body
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, ok: response.ok, json };
}

async function githubGet(token, apiPath) {
  return githubRequest(token, apiPath);
}

async function status({ config, args, chatId }) {
  const token = String(config.GITHUB_TOKEN || "").trim();
  if (!token) return missingToken(chatId);

  const userResult = await githubGet(token, "/user");
  if (!userResult.ok) return toolError(`GitHub token check failed with HTTP ${userResult.status}.`);

  const repo = normalizeRepo(args.repo || config.DEFAULT_REPO || "");
  let repoAccess = null;
  if (repo) {
    const repoResult = await githubGet(token, `/repos/${repo}`);
    repoAccess = {
      repo,
      ok: repoResult.ok,
      httpStatus: repoResult.status,
      permissions: repoResult.json?.permissions || null,
      private: Boolean(repoResult.json?.private),
      defaultBranch: repoResult.json?.default_branch || null
    };
  }

  return toolOk({
    text: repoAccess
      ? `GitHub token works as ${userResult.json.login}. Repo ${repoAccess.repo}: ${repoAccess.ok ? "accessible" : `not accessible (${repoAccess.httpStatus})`}.`
      : `GitHub token works as ${userResult.json.login}.`,
    json: {
      action: "status",
      tokenValid: true,
      login: userResult.json.login,
      id: userResult.json.id,
      repoAccess
    },
    mimeType: "application/json"
  });
}

async function star({ config, args, chatId }) {
  const token = String(config.GITHUB_TOKEN || "").trim();
  if (!token) return missingToken(chatId);

  const repo = normalizeRepo(args.repo || config.DEFAULT_REPO || "");
  if (!repo || !repo.includes("/")) {
    return toolError("Missing repo. Provide args.repo as owner/name or a GitHub URL.");
  }

  const result = await githubRequest(token, `/user/starred/${repo}`, {
    method: "PUT",
    headers: { "Content-Length": "0" }
  });

  const ok = result.status === 204 || result.status === 304;
  if (!ok) return toolError(`Could not star ${repo}; GitHub returned HTTP ${result.status}.`);
  return toolOk({
    text: `Starred ${repo} as the configured GitHub user.`,
    json: { action: "star", repo, ok: true, httpStatus: result.status },
    mimeType: "application/json"
  });
}

async function sync({ config, args, chatId }) {
  if (!chatId) return toolError("A chatId is required.");
  const token = String(config.GITHUB_TOKEN || "").trim();
  if (!token) return missingToken(chatId);
  const repo = normalizeRepo(args.repo);
  const branch = String(args.branch || "");
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[A-Za-z0-9_-]+$/.test(branch)) return toolError("Exact repository and simple branch required.");
  const { getChatToolStateDir } = await importCore("runtime/paths.js");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  const cwd = path.join(getChatToolStateDir(chatId, TOOL_NAME), "checkouts", repo.replace("/", "--"));
  const git = async (...a) => (await execute("git", a, { cwd, timeout: 120000 })).stdout.trim();
  if (await git("remote", "get-url", "origin") !== `https://github.com/${repo}.git`) return toolError("Origin mismatch");
  if (await git("status", "--porcelain") || await git("branch", "--show-current") !== branch) return toolError("Dirty checkout or branch mismatch");
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` };
  try { await execute("git", ["fetch", "origin", branch], {cwd, env, timeout: 120000}); } catch { return toolError("Authenticated fetch failed"); }
  await git("merge", "--ff-only", `origin/${branch}`);
  return toolOk({ text: "Checkout synchronized without discarding changes.", json: { path: cwd, revision: await git("rev-parse", "HEAD") } });
}

async function checkout({ config, args, chatId }) {
  if (!chatId) return toolError("A chatId is required.");
  const token = String(config.GITHUB_TOKEN || "").trim();
  if (!token) return missingToken(chatId);
  const repo = normalizeRepo(args.repo);
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return toolError("Invalid exact repository.");
  const { getChatToolStateDir } = await importCore("runtime/paths.js");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const root = path.join(getChatToolStateDir(chatId, TOOL_NAME), "checkouts");
  await fs.mkdir(root, { recursive: true });
  const destination = path.join(root, repo.replace("/", "--"));
  try { await fs.access(destination); return toolError("Checkout already exists; preserve it and inspect locally."); } catch {}
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` };
  try { await run("git", ["clone", "--depth", "1", "--", `https://github.com/${repo}.git`, destination], { env, timeout: 120000, maxBuffer: 1000000 }); }
  catch { return toolError("Authenticated clone failed; inspect checkout before retry."); }
  const { stdout } = await run("git", ["-C", destination, "rev-parse", "HEAD"]);
  return toolOk({ text: "Repository cloned into chat-scoped state.", json: { repo, path: destination, revision: stdout.trim() } });
}

async function invitation({ config, args, chatId }) {
  if (!chatId) return toolError("A chatId is required.");
  const token = String(config.GITHUB_TOKEN || "").trim();
  if (!token) return missingToken(chatId);
  const repo = normalizeRepo(args.repo);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return toolError("An exact owner/name is required.");
  let found = null;
  for (let page = 1; page <= 10; page++) {
    const result = await githubGet(token, `/user/repository_invitations?per_page=100&page=${page}`);
    if (!result.ok || !Array.isArray(result.json)) return toolError(`Invitation lookup failed with HTTP ${result.status}.`);
    found = result.json.find(item => item.repository?.full_name?.toLowerCase() === repo.toLowerCase());
    if (found || result.json.length < 100) break;
  }
  if (!found) return toolOk({ text: `No pending invitation found for ${repo}.`, json: { repo, found: false } });
  if (args.confirm !== "true") return toolOk({ text: `Pending invitation found for ${repo}. Use confirm=true to accept.`, json: { repo, found: true } });
  if (!Number.isSafeInteger(found.id)) return toolError("Invalid invitation identifier.");
  const result = await githubRequest(token, `/user/repository_invitations/${found.id}`, { method: "PATCH" });
  if (result.status !== 204) return toolError(`Invitation acceptance returned HTTP ${result.status}; verify status before retrying.`);
  return toolOk({ text: `Accepted invitation for ${repo}.`, json: { repo, accepted: true } });
}

async function main() {
  if (process.argv.includes("--help") || process.argv.length <= 2) {
    process.stdout.write(usage());
    return;
  }

  const requestFileIndex = process.argv.indexOf("--request-file");
  if (process.argv[2] !== "run" || requestFileIndex < 0 || !process.argv[requestFileIndex + 1]) {
    fail("Expected run --request-file <json>");
    return;
  }

  const requestPath = process.argv[requestFileIndex + 1];
  const request = JSON.parse(await fs.readFile(requestPath, "utf8"));
  const args = request.args || {};
  const config = await loadToolConfig(TOOL_NAME, defaults, request.chatId);
  const action = args.action || "status";

  if (action === "status") return printResult(await status({ config, args, chatId: request.chatId }));
  if (action === "star") return printResult(await star({ config, args, chatId: request.chatId }));
  if (action === "sync") return printResult(await sync({ config, args, chatId: request.chatId }));
  if (action === "checkout") return printResult(await checkout({ config, args, chatId: request.chatId }));
  if (action === "invitation") return printResult(await invitation({ config, args, chatId: request.chatId }));
  fail(`Unsupported action: ${action}`);
}

main().catch((error) => fail(error.message || String(error)));
