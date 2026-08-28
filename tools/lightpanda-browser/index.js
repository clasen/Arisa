import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import defaults from "./config.js";
import { readBinaryVersion, resolveBinary, runProcess } from "./binary.js";
import { performBrowse } from "./browser-operation.js";
import { performInteraction } from "./mcp-session.js";
import { createPersistentSessionService } from "./daemon-service.js";
import { RecipeStore, validateRecipe } from "./recipe-store.js";
import { searchWeb } from "./web-search.js";

const toolName = "lightpanda-browser";

function help() {
  console.log(`lightpanda-browser\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n  node index.js daemon  # managed internally by Arisa\n\nModes:\n  status         Verify the installed Lightpanda binary.\n  search         Search the public web through bounded hedged HTTP providers.\n  open           Open a public JavaScript-rendered page as bounded Markdown.\n  render         Return the bounded rendered DOM as HTML.\n  extract-links  Extract bounded HTTP(S) links from the rendered DOM.\n  interact       Run a bounded, stateful MCP sequence in one ephemeral browser.\n  session-open   Open a temporary chat-scoped browser session.\n  session-call   Call one allowlisted MCP tool in an existing session.\n  session-capture Return a bounded text-layout PNG from an existing session.\n  session-list   List this chat's temporary sessions.\n  session-close  Close one temporary session explicitly.\n  recipe-save    Save a validated read/interact sequence in chat-scoped state.\n  recipe-list    List this chat's deterministic recipes.\n  recipe-run     Revalidate and replay one recipe without a model.\n  recipe-delete  Delete one recipe.\n\nSearch input: request.args.query, request.text, or request.artifact.text.\nBrowse input URL: request.args.url, request.text, or request.artifact.text.\nInteract input: request.args.steps as a JSON array string. Mutation operations also require allowMutations=true.\nSession call args: sessionId, tool, toolArgs (JSON object string), actionLevel=read|interact|commit, commitIntent=submit-form|post-content|delete when required.\nCapture args: sessionId, selector?, fullPage?. Recipe args: name?, recipeId?, steps?, actionLevel=read|interact.\nOptional args: timeoutMs, maxOutputBytes, waitMs, waitSelector, selector, maxLinks, stripUi.\n\nThis tool handles anonymous public search and JavaScript rendering. It never falls back to Chromium silently.\n`);
}

function coreImport(relativePath) {
  const packageDir = process.env.ARISA_PACKAGE_DIR;
  if (!packageDir) throw new Error("ARISA_PACKAGE_DIR is required when running the tool.");
  return import(pathToFileURL(path.join(packageDir, "src", relativePath)).href);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function chatDaemonRuntime(createDaemonRuntime, chatId) {
  const normalizedChatId = String(chatId || "");
  if (!normalizedChatId) throw new Error("chatId is required for persistent Lightpanda sessions.");
  return createDaemonRuntime({
    toolName,
    entryPath: fileURLToPath(import.meta.url),
    scope: { type: "chat", chatId: normalizedChatId },
    startupContext: { chatId: normalizedChatId },
    autoStart: true
  });
}

function jsonObject(value, label) {
  if (value === undefined || value === "") return {};
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); }
    catch { throw new Error(`${label} must be a JSON object string.`); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object string.`);
  return parsed;
}

async function run(request) {
  const [{ loadToolConfig }, { toolOk, toolError }, { getChatToolStateDir, getToolStateDir }, { createDaemonRuntime }] = await Promise.all([
    coreImport("core/tools/tool-config.js"),
    coreImport("core/tools/tool-result.js"),
    coreImport("runtime/paths.js"),
    coreImport("core/tools/daemon-runtime.js")
  ]);
  try {
    const config = await loadToolConfig(toolName, defaults, request.chatId);
    const mode = String(request.args?.action || request.args?.mode || "status").trim().toLowerCase();
    if (mode.startsWith("recipe-")) {
      if (!request.chatId) return toolError("chatId is required for recipes.");
      const store = new RecipeStore(getChatToolStateDir(String(request.chatId), toolName));
      if (mode === "recipe-save") {
        if (!request.args?.steps) return toolError("recipe-save requires steps as a JSON array string.");
        const recipe = await validateRecipe({
          name: request.args?.name,
          steps: request.args.steps,
          actionLevel: request.args?.actionLevel || "read"
        });
        const saved = await store.save(recipe);
        return toolOk({ text: `Saved Lightpanda recipe ${saved.name} (${saved.id}).`, json: saved });
      }
      if (mode === "recipe-list") {
        const recipes = await store.list();
        return toolOk({
          text: recipes.length ? recipes.map((recipe) => `${recipe.id} — ${recipe.name} [${recipe.actionLevel}]`).join("\n") : "No Lightpanda recipes are saved for this chat.",
          json: { recipes }
        });
      }
      const recipeId = String(request.args?.recipeId || "").trim();
      if (!recipeId) return toolError(`${mode} requires recipeId.`);
      if (mode === "recipe-delete") {
        const output = await store.delete(recipeId);
        return toolOk({ text: output.deleted ? `Deleted Lightpanda recipe ${recipeId}.` : `Lightpanda recipe ${recipeId} was not found.`, json: output });
      }
      if (mode === "recipe-run") {
        const stored = await store.get(recipeId);
        const recipe = await validateRecipe(stored);
        const binary = await resolveBinary(config.LIGHTPANDA_BINARY, getToolStateDir(toolName));
        const output = await performInteraction({
          steps: recipe.steps,
          allowMutations: false,
          config,
          args: { ...request.args, actionLevel: recipe.actionLevel, commitIntent: "" },
          binary
        });
        output.json.recipe = { id: stored.id, name: recipe.name, actionLevel: recipe.actionLevel };
        return toolOk(output);
      }
      return toolError(`Unknown recipe action: ${mode}.`);
    }
    if (mode.startsWith("session-")) {
      const daemon = chatDaemonRuntime(createDaemonRuntime, request.chatId);
      const timeoutMs = boundedInteger(config.JOB_TIMEOUT_MS, defaults.JOB_TIMEOUT_MS, 5_000, 60_000);
      const readyTimeoutMs = boundedInteger(config.READY_TIMEOUT_MS, defaults.READY_TIMEOUT_MS, 5_000, 60_000);
      if (mode === "session-open") {
        const output = await daemon.submit({ action: mode }, { timeoutMs, readyTimeoutMs });
        return toolOk({ text: `Opened temporary Lightpanda session ${output.id}.`, json: output });
      }
      if (mode === "session-list") {
        const output = await daemon.submit({ action: mode }, { timeoutMs, readyTimeoutMs });
        const text = output.sessions.length
          ? output.sessions.map((session) => `${session.id} — expires ${session.expiresAt}${session.busy ? " (busy)" : ""}`).join("\n")
          : "No temporary Lightpanda sessions are active.";
        return toolOk({ text, json: output });
      }
      const sessionId = String(request.args?.sessionId || "").trim();
      if (!sessionId) return toolError(`${mode} requires sessionId.`);
      if (mode === "session-close") {
        const output = await daemon.submit({ action: mode, sessionId }, { timeoutMs, readyTimeoutMs });
        return toolOk({ text: output.closed ? `Closed Lightpanda session ${sessionId}.` : `Lightpanda session ${sessionId} was already closed or expired.`, json: output });
      }
      if (mode === "session-capture") {
        const output = await daemon.submit({
          action: mode,
          sessionId,
          selector: request.args?.selector,
          fullPage: request.args?.fullPage === true || request.args?.fullPage === "true"
        }, { timeoutMs, readyTimeoutMs });
        return toolOk({
          filePath: output.filePath,
          fileName: output.fileName,
          mimeType: output.mimeType,
          kind: output.kind,
          delivery: output.delivery,
          json: { sessionId, finalUrl: output.finalUrl, width: output.width, height: output.height, bytes: output.bytes }
        });
      }
      if (mode === "session-call") {
        const tool = String(request.args?.tool || "").trim();
        if (!tool) return toolError("session-call requires tool.");
        const output = await daemon.submit({
          action: mode,
          sessionId,
          tool,
          arguments: jsonObject(request.args?.toolArgs ?? request.args?.arguments, "toolArgs"),
          actionLevel: request.args?.actionLevel,
          commitIntent: request.args?.commitIntent,
          allowMutations: request.args?.allowMutations === true || request.args?.allowMutations === "true",
          maxOutputBytes: request.args?.maxOutputBytes
        }, { timeoutMs, readyTimeoutMs });
        return toolOk({ text: output.text, json: output });
      }
      return toolError(`Unknown session action: ${mode}.`);
    }
    if (mode === "search") {
      const query = request.args?.query || request.text || request.artifact?.text;
      if (!query) return toolError("search requires args.query, text, or artifact text.");
      const output = await searchWeb(query, {
        maxResults: request.args?.maxResults,
        timeoutMs: request.args?.timeoutMs ?? config.SEARCH_TIMEOUT_MS,
        maxResponseBytes: request.args?.maxResponseBytes ?? config.SEARCH_MAX_RESPONSE_BYTES
      });
      return toolOk({
        text: output.text,
        json: {
          engine: "lightpanda-search",
          transport: "bounded-http",
          provider: output.provider,
          query: output.query,
          results: output.results,
          elapsedMs: output.elapsedMs
        }
      });
    }
    const binary = await resolveBinary(config.LIGHTPANDA_BINARY, getToolStateDir(toolName));
    if (mode === "status") {
      const version = await readBinaryVersion(binary);
      return toolOk({
        text: `Lightpanda is installed and executable. Version: ${version}`,
        json: { available: true, version }
      });
    }
    if (mode === "interact") {
      if (!request.args?.steps) return toolError("interact requires steps as a JSON array string.");
      return toolOk(await performInteraction({
        steps: request.args.steps,
        allowMutations: request.args.allowMutations === true || request.args.allowMutations === "true",
        config,
        args: request.args,
        binary
      }));
    }
    const input = request.args?.url || request.text || request.artifact?.text;
    if (!input) return toolError("A public HTTP(S) URL is required.");
    return toolOk(await performBrowse({ input, mode, config, args: request.args, binary, execute: runProcess }));
  } catch (error) {
    return toolError(error?.message || String(error), {
      code: error?.code,
      retryable: error?.retryable === true,
      resolution: ["LIGHTPANDA_TIMEOUT", "LIGHTPANDA_PAGE_FAILED", "LIGHTPANDA_INCOMPATIBLE"].includes(error?.code)
        ? { type: "select_alternate_browser", attempted: "lightpanda-browser", automaticFallback: false }
        : undefined
    });
  }
}

async function runDaemon() {
  const [{ loadToolConfig }, { createDaemonRuntime }, { readDaemonLaunchContext }, { getChatToolTmpDir, getToolStateDir }] = await Promise.all([
    coreImport("core/tools/tool-config.js"),
    coreImport("core/tools/daemon-runtime.js"),
    coreImport("core/tools/daemon-processes.js"),
    coreImport("runtime/paths.js")
  ]);
  const launch = await readDaemonLaunchContext({ expectedToolName: toolName });
  const chatId = String(launch?.startupContext?.chatId || launch?.scope?.chatId || "");
  if (!chatId) throw new Error("Chat-scoped Lightpanda daemon launch is missing chatId.");
  const daemon = chatDaemonRuntime(createDaemonRuntime, chatId);
  let config = await loadToolConfig(toolName, defaults, chatId);
  let binary = await resolveBinary(config.LIGHTPANDA_BINARY, getToolStateDir(toolName));
  const tmpDir = getChatToolTmpDir(chatId, toolName);
  let service = createPersistentSessionService({ binary, config, tmpDir });
  await daemon.workLoop({
    idleTimeoutMs: boundedInteger(config.IDLE_TIMEOUT_MS, defaults.IDLE_TIMEOUT_MS, 60_000, 60 * 60_000),
    processJob: (job, context) => service.processJob(job, context),
    healthCheck: () => service.healthCheck(),
    recover: async () => {
      await service.close("recovery");
      config = await loadToolConfig(toolName, defaults, chatId);
      binary = await resolveBinary(config.LIGHTPANDA_BINARY, getToolStateDir(toolName));
      service = createPersistentSessionService({ binary, config, tmpDir });
      return true;
    },
    beforeExit: () => service.close("daemon-exit")
  });
}

async function main() {
  if (process.argv.includes("--help") || process.argv.length <= 2) return help();
  const [, , command, flag, requestFile] = process.argv;
  if (command === "daemon") return runDaemon();
  if (command !== "run" || flag !== "--request-file" || !requestFile) {
    console.log(JSON.stringify({ ok: false, error: "Invalid usage. Run node index.js --help." }));
    return;
  }
  try {
    const request = JSON.parse((await readFile(requestFile, "utf8")).replace(/^\uFEFF/, ""));
    console.log(JSON.stringify(await run(request)));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error?.message || String(error) }));
  }
}

await main();
