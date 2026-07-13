import dns from "node:dns/promises";
import net from "node:net";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import DeepBase from "deepbase";
import defaults from "./config.js";

const toolName = "roster-sites";
const entryPath = fileURLToPath(import.meta.url);
const toolDir = path.dirname(entryPath);
const require = createRequire(import.meta.url);
const arisaPackageDir = process.env.ARISA_PACKAGE_DIR || process.env.ARISA_INSTALL_DIR || path.resolve(toolDir, "../../package");
const pathsModule = await import(pathToFileURL(path.join(arisaPackageDir, "src/runtime/paths.js")));
const {
  getChatToolStateDir,
  getToolStateDir
} = pathsModule;
const { loadToolConfig } = await import(pathToFileURL(path.join(arisaPackageDir, "src/core/tools/tool-config.js")).href);
const { createDaemonRuntime } = await import(pathToFileURL(path.join(arisaPackageDir, "src/core/tools/daemon-runtime.js")).href);
const { isProcessAlive, readJson } = await import(pathToFileURL(path.join(arisaPackageDir, "src/core/tools/daemon-processes.js")).href);
const daemon = createDaemonRuntime({ toolName, entryPath, autoStart: true });

function printHelp() {
  console.log(`roster-sites

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions via args.action:
  start     Start the RosterServer daemon.
  stop      Stop the RosterServer daemon.
  status    Show daemon status, pid, alive flag, and runtime paths.
  init      Create/update a domain home page from HTML and ensure the daemon is running. Requires args.domain unless a default is configured.
  publish   Publish a page at /<slug>. Accepts args.domain, args.slug, args.title and HTML text/artifact.
  list      List persisted pages for one domain. Requires args.domain unless a default is configured.
  domains   List domains known to this tool.
  dns       Check DNS for a domain and www.<domain> against this VPS. Requires args.domain unless a default is configured.

Persistent page metadata is stored in the chat-scoped tool state.
Runtime daemon files stay under ~/.arisa/state/tools/roster-sites.
`);
}

async function loadConfig(chatId = null) {
  return loadToolConfig(toolName, defaults, chatId);
}

function resultOk(output) { return { ok: true, output: { text: JSON.stringify(output, null, 2), mimeType: "application/json" } }; }
function resultError(error) { return { ok: false, error: error?.message || String(error) }; }

async function stopDaemon() {
  const pid = await daemon.getPid();
  await daemon.stop();
  return { ok: true, action: "stop", pid };
}

async function startDaemon() {
  const pid = await daemon.start();
  const status = await daemon.ensureReady();
  return { ok: true, action: "start", pid, status, paths: daemon.paths };
}

function slugify(value = "") {
  const slug = String(value).toLowerCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || `page-${Date.now()}`;
}

function titleFromHtml(html = "", fallback = "Untitled") {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return (match?.[1] || fallback).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function pageKey(domain, slug) { return `${domain}::${slug}`; }
function getStateRoot(chatId) { return chatId == null ? getToolStateDir(toolName) : getChatToolStateDir(chatId, toolName); }

async function openDb(chatId) {
  const db = new DeepBase({ path: path.join(getStateRoot(chatId), "db"), name: "roster-sites" });
  await db.connect();
  return db;
}

async function readInputHtml(request) {
  if (request.artifact?.path) return readFile(request.artifact.path, "utf8");
  if (request.text) return request.text;
  if (request.artifact?.text) return request.artifact.text;
  return "";
}

function parsePageEntry(key, page, fallbackDomain) {
  if (String(key).includes("::")) {
    const [domain, slug] = String(key).split("::");
    return { domain, slug, ...page };
  }
  return { domain: fallbackDomain, slug: key, ...page };
}

async function getAllPages(db, domain, fallbackDomain = domain) {
  const entries = await db.entries("pages").catch(() => []);
  const bySlug = new Map();
  for (const [key, rawPage] of entries) {
    const page = parsePageEntry(key, rawPage, fallbackDomain);
    if (page.domain !== domain) continue;
    const previous = bySlug.get(page.slug);
    const previousTime = Date.parse(previous?.updatedAt || previous?.createdAt || "") || 0;
    const pageTime = Date.parse(page.updatedAt || page.createdAt || "") || 0;
    if (!previous || pageTime >= previousTime || String(key).includes("::")) bySlug.set(page.slug, page);
  }
  return [...bySlug.values()].sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
}

async function getKnownDomains(db, fallbackDomain) {
  const entries = await db.entries("pages").catch(() => []);
  return [...new Set(entries.map(([key, page]) => parsePageEntry(key, page, fallbackDomain).domain))].sort();
}

async function savePage(db, { domain, slug, title, html, kind = "page" }) {
  const now = new Date().toISOString();
  const key = pageKey(domain, slug);
  const existing = await db.get("pages", key).catch(() => null);
  const page = { title: title || titleFromHtml(html, slug), html, kind, createdAt: existing?.createdAt || now, updatedAt: now };
  await db.set("pages", key, page);
  return { domain, slug, ...page };
}

function siteHandlerSource(domain) {
  return `import { readFile } from "node:fs/promises";\nimport path from "node:path";\nimport { fileURLToPath, pathToFileURL } from "node:url";\n\nconst root = path.dirname(fileURLToPath(import.meta.url));\nconst domain = ${JSON.stringify(domain)};\nconst types = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml" };\nlet customRoutesPromise;\n\nfunction safeDecodePathname(pathname) {\n  try { return decodeURIComponent(pathname); }\n  catch { return pathname; }\n}\n\nasync function sendFile(res, filePath) {\n  const ext = path.extname(filePath);\n  const body = await readFile(filePath);\n  res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });\n  res.end(body);\n}\n\nasync function loadPages() {\n  return JSON.parse(await readFile(path.join(root, "data", "pages.json"), "utf8"));\n}\n\nasync function loadCustomRoutes() {\n  if (!customRoutesPromise) {\n    customRoutesPromise = import(pathToFileURL(path.join(root, "custom-routes.js")).href).catch((error) => {\n      if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "ENOENT") return null;\n      throw error;\n    });\n  }\n  return customRoutesPromise;\n}\n\nfunction notFound(res) {\n  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });\n  res.end("not found");\n}\n\nexport default () => async (req, res) => {\n  const url = new URL(req.url || "/", ` + "`https://${domain}`" + `);\n  const pathname = safeDecodePathname(url.pathname);\n  try {\n    const customRoutes = await loadCustomRoutes();\n    if (typeof customRoutes?.handleCustomRoute === "function") {\n      const handled = await customRoutes.handleCustomRoute(req, res, { root, domain, url, pathname, sendFile });\n      if (handled) return;\n    }\n\n    if (pathname.startsWith("/assets/")) {\n      const relative = pathname.slice(1);\n      if (relative.includes("..")) return notFound(res);\n      try {\n        return await sendFile(res, path.join(root, relative));\n      } catch (error) {\n        if (error?.code === "ENOENT") return notFound(res);\n        throw error;\n      }\n    }\n    const pages = await loadPages();\n    const slug = pathname === "/" ? "home" : pathname.replace(/^\\/+|\\/+$/g, "");\n    const page = pages.find((item) => item.slug === slug);\n    if (!page) return notFound(res);\n    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });\n    res.end(page.html);\n  } catch (error) {\n    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });\n    res.end(error.message || String(error));\n  }\n};\n`;
}
function fallbackStyles() { return `:root{color-scheme:dark;--bg:#1d2021;--fg:#ebdbb2;--muted:#928374;--orange:#fe8019;--green:#b8bb26;--blue:#83a598;--red:#fb4934;--panel:#282828;--line:#3c3836}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#32302f 0,#1d2021 34rem);color:var(--fg);font-family:"Fira Code",ui-monospace,monospace;line-height:1.55}a{color:var(--blue)}`; }
function appScript() { return `window.__applyTweaks=window.__applyTweaks||(()=>{});`; }

async function deploySite(config, domain, pages) {
  requireConfig(config, ["email", "wwwPath", "greenlockStorePath"]);
  const siteDir = path.join(config.wwwPath, domain);
  await mkdir(path.join(siteDir, "assets"), { recursive: true });
  await mkdir(path.join(siteDir, "data"), { recursive: true });
  await writeFile(path.join(siteDir, "index.js"), siteHandlerSource(domain), "utf8");
  await writeFile(path.join(siteDir, "assets", "styles.css"), fallbackStyles(), "utf8");
  await writeFile(path.join(siteDir, "assets", "app.js"), appScript(), "utf8");
  await writeFile(path.join(siteDir, "assets", "tweaks-panel.jsx"), "", "utf8");
  await writeFile(path.join(siteDir, "assets", "tweaks.jsx"), "", "utf8");
  await writeFile(path.join(siteDir, "data", "pages.json"), `${JSON.stringify(pages, null, 2)}\n`, "utf8");
  await writeFile(path.join(siteDir, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2), "utf8");
  return siteDir;
}

async function hasMx(email) {
  const domain = String(email || "").split("@")[1] || "";
  if (!domain) return false;
  return (await dns.resolveMx(domain).catch(() => [])).length > 0;
}

async function startRosterServer(config) {
  requireConfig(config, ["email", "wwwPath", "greenlockStorePath"]);
  if (!(await hasMx(config.email))) throw new Error(`RosterServer contact email needs a domain with MX records: ${config.email}`);
  const Roster = require("roster-server");
  const server = new Roster({ email: config.email, wwwPath: config.wwwPath, greenlockStorePath: config.greenlockStorePath });
  await Promise.resolve(server.start());
  return server;
}

async function probePort(port) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

async function probeRosterServer() {
  const errors = [];
  for (const port of [443, 80]) {
    try {
      await probePort(port);
      return { message: `RosterServer is accepting connections on port ${port}` };
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }
  throw new Error(`RosterServer listeners are unavailable: ${errors.join("; ")}`);
}

async function runDaemon() {
  try {
    let config = await loadConfig();
    let server = await startRosterServer(config);
    await daemon.writeStatus({
      wwwPath: config.wwwPath,
      greenlockStorePath: config.greenlockStorePath
    });
    await daemon.workLoop({
      processJob: async () => ({ running: true }),
      healthCheck: probeRosterServer,
      recover: async () => {
        if (typeof server?.stop !== "function") return false;
        await Promise.resolve(server.stop());
        config = await loadConfig();
        server = await startRosterServer(config);
        await daemon.writeStatus({
          wwwPath: config.wwwPath,
          greenlockStorePath: config.greenlockStorePath
        });
        return true;
      }
    });
  } catch (error) {
    await daemon.writeStatus({
      state: "failed",
      lastError: { at: new Date().toISOString(), phase: "start", message: error?.message || String(error) },
      message: error?.message || String(error)
    });
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

async function statusAction() {
  const status = await readJson(daemon.paths.statusFile, {});
  const pid = await daemon.getPid();
  return { ...status, pid, alive: isProcessAlive(pid), paths: daemon.paths };
}

async function dnsAction(domain) {
  const [a, www] = await Promise.all([
    dns.resolve4(domain).catch(() => []),
    dns.resolve4(`www.${domain}`).catch(() => [])
  ]);
  return { domain, a, www };
}

function resolveDomain(args = {}, config = {}, { required = false } = {}) {
  const domain = String(args.domain || config.defaultDomain || config.domain || "").trim();
  if (required && !domain) throw new Error("args.domain is required for this action unless defaultDomain is configured");
  return domain;
}

function requireConfig(config, fields) {
  const missing = fields.filter((field) => !String(config[field] || "").trim());
  if (missing.length) throw new Error(`Missing required roster-sites config: ${missing.join(", ")}`);
}

async function handleRun(request) {
  const args = request.args || {};
  const action = args.action || "status";
  const config = await loadConfig(request.chatId);
  const domain = resolveDomain(args, config, { required: ["dns", "list", "init", "publish"].includes(action) });

  if (action === "start") return startDaemon();
  if (action === "stop") return stopDaemon();
  if (action === "status") return statusAction();
  if (action === "dns") return dnsAction(domain);

  const db = await openDb(request.chatId);
  if (action === "domains") return { ok: true, action, domains: await getKnownDomains(db, config.domain) };
  if (action === "list") return { ok: true, action, domain, pages: await getAllPages(db, domain, config.domain) };

  if (action === "init" || action === "publish") {
    const html = await readInputHtml(request);
    if (!html.trim()) throw new Error(`${action} needs HTML text or an HTML artifact`);
    const slug = action === "init" ? "home" : slugify(args.slug || args.title || titleFromHtml(html));
    const page = await savePage(db, { domain, slug, title: args.title, html, kind: action === "init" ? "home" : "page" });
    const pages = await getAllPages(db, domain, config.domain);
    const siteDir = await deploySite(config, domain, pages);
    const daemon = await startDaemon();
    return { ok: true, action, domain, url: `https://${domain}/${slug === "home" ? "" : slug}`, siteDir, daemon: { pid: daemon.pid, status: daemon.status }, page: { slug: page.slug, title: page.title, updatedAt: page.updatedAt } };
  }

  throw new Error(`Unknown action: ${action}`);
}

async function main() {
  const [command, flag, requestFile] = process.argv.slice(2);
  if (command === "--help" || command === "help" || !command) return printHelp();
  if (command === "daemon") return runDaemon();
  if (command !== "run" || flag !== "--request-file" || !requestFile) {
    console.log(JSON.stringify(resultError("Usage: node index.js run --request-file <json>")));
    return;
  }
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    console.log(JSON.stringify(resultOk(await handleRun(request))));
  } catch (error) {
    console.log(JSON.stringify(resultError(error)));
  }
}

main();
