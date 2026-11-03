import dns from "node:dns/promises";
import https from "node:https";
import { access, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
const importCore = (relativePath) => import(pathToFileURL(path.join(arisaPackageDir, "src", relativePath)).href);
const { loadToolConfig } = await importCore("core/tools/tool-config.js");
const { createDaemonRuntime } = await importCore("core/tools/daemon-runtime.js");
const { isProcessAlive, readJson } = await importCore("core/tools/daemon-processes.js");
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
  register  Persist an owner-approved server handler directory. args.domain, args.sitePath (absolute, inside chat state). Backed up; restart required.
  init      Create/update a domain home page from HTML and ensure the daemon is running. Requires args.domain unless a default is configured.
  publish   Publish a page at /<slug>. Accepts args.domain, args.slug, args.title and HTML text/artifact.
  page-only Update one existing-domain page without rewriting handlers/assets. Retains a backup; args.slug and HTML artifact required.
  root-text Publish robots.txt, llms.txt, or sitemap.xml at the domain root from text/artifact. Reload the daemon if reloadRequired is true.
  audio-routes Enable MP3 MIME, content length, HEAD, and byte ranges on a deployed domain. Reload server afterward.
  asset     Publish a file under /assets/<fileName>. Requires an input artifact and args.fileName.
  static-deploy Deploy a complete built static site from a JSON artifact {revision,files:[{path,base64}]}. Existing domains only; retains a chat-scoped backup. Reload the daemon when reloadRequired is true.
  static-restore Restore args.backupId for args.domain. Reload the daemon afterward.
  story-index Publish bilingual Story collection pages from an arisa-site index artifact.
  story-pair Publish a validated bilingual arisa.sh Story pair artifact at its existing static routes.
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

async function startDaemon() {
  const pid = await daemon.start();
  const status = await daemon.ensureReady();
  return { ok: true, action: "start", pid, status, paths: daemon.paths };
}

async function stopDaemon() {
  const pid = await daemon.getPid();
  await daemon.stop();
  return { ok: true, action: "stop", pid: pid || null };
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
  return `import { readFile } from "node:fs/promises";\nimport path from "node:path";\nimport { fileURLToPath, pathToFileURL } from "node:url";\nimport * as customRoutes from "./custom-routes.js";\n\nconst root = path.dirname(fileURLToPath(import.meta.url));\nconst domain = ${JSON.stringify(domain)};\nconst types = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };\nlet customRoutesPromise;\n\nfunction safeDecodePathname(pathname) {\n  try { return decodeURIComponent(pathname); }\n  catch { return pathname; }\n}\n\nasync function sendFile(res, filePath) {\n  const ext = path.extname(filePath);\n  const body = await readFile(filePath);\n  res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });\n  res.end(body);\n}\n\nasync function loadPages() {\n  return JSON.parse(await readFile(path.join(root, "data", "pages.json"), "utf8"));\n}\n\nasync function loadCustomRoutes() {\n  if (!customRoutesPromise) {\n    customRoutesPromise = import(pathToFileURL(path.join(root, "custom-routes.js")).href).catch((error) => {\n      if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "ENOENT") return null;\n      throw error;\n    });\n  }\n  return customRoutesPromise;\n}\n\nfunction notFound(res) {\n  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });\n  res.end("not found");\n}\n\nexport default (virtualServer) => {\n  customRoutes.registerCustomRoutes?.(virtualServer);\n  return async (req, res) => {\n  const url = new URL(req.url || "/", ` + "`https://${domain}`" + `);\n  const pathname = safeDecodePathname(url.pathname);\n  try {\n    const customRoutes = await loadCustomRoutes();\n    if (typeof customRoutes?.handleCustomRoute === "function") {\n      const handled = await customRoutes.handleCustomRoute(req, res, { root, domain, url, pathname, sendFile });\n      if (handled) return;\n    }\n\n    if (pathname.startsWith("/assets/")) {\n      const relative = pathname.slice(1);\n      if (relative.includes("..")) return notFound(res);\n      try {\n        return await sendFile(res, path.join(root, relative));\n      } catch (error) {\n        if (error?.code === "ENOENT") return notFound(res);\n        throw error;\n      }\n    }\n    const pages = await loadPages();\n    const slug = pathname === "/" ? "home" : pathname.replace(/^\\/+|\\/+$/g, "");\n    const page = pages.find((item) => item.slug === slug);\n    if (!page) return notFound(res);\n    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });\n    res.end(page.html);\n  } catch (error) {\n    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });\n    res.end(error.message || String(error));\n  }\n};\n}\n`;
}
function fallbackStyles() { return `:root{color-scheme:dark;--bg:#1d2021;--fg:#ebdbb2;--muted:#928374;--orange:#fe8019;--green:#b8bb26;--blue:#83a598;--red:#fb4934;--panel:#282828;--line:#3c3836}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#32302f 0,#1d2021 34rem);color:var(--fg);font-family:"Fira Code",ui-monospace,monospace;line-height:1.55}a{color:var(--blue)}`; }
function appScript() { return `window.__applyTweaks=window.__applyTweaks||(()=>{});`; }

async function deploySite(config, domain, pages) {
  requireConfig(config, ["email", "wwwPath", "greenlockStorePath"]);
  const siteDir = path.join(config.wwwPath, domain);
  await mkdir(path.join(siteDir, "assets"), { recursive: true });
  await mkdir(path.join(siteDir, "data"), { recursive: true });
  await writeFile(path.join(siteDir, "index.js"), (await import("./root-text.js")).withRootTextRoutes(siteHandlerSource(domain)), "utf8");
  await readFile(path.join(siteDir, "custom-routes.js"), "utf8").catch(() => writeFile(
    path.join(siteDir, "custom-routes.js"),
    "export function registerCustomRoutes() {}\nexport async function handleCustomRoute() { return false; }\n",
    "utf8"
  ));
  await writeFile(path.join(siteDir, "assets", "styles.css"), fallbackStyles(), "utf8");
  await writeFile(path.join(siteDir, "assets", "app.js"), appScript(), "utf8");
  await writeFile(path.join(siteDir, "assets", "tweaks-panel.jsx"), "", "utf8");
  await writeFile(path.join(siteDir, "assets", "tweaks.jsx"), "", "utf8");
  await writeFile(path.join(siteDir, "data", "pages.json"), `${JSON.stringify(pages, null, 2)}\n`, "utf8");
  await writeFile(path.join(siteDir, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2), "utf8");
  await (await import('./audio-deploy.js')).deployAudioRoutes(config, domain);
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
  // Discovery replaces registrations; apply overrides after discovery but before
  // start builds isolated routes and launches any site workers.
  const discoverSites = server.loadSites.bind(server);
  server.loadSites = async () => {
    await discoverSites();
    await (await import('./site-registration.js')).applyRegistrations(server, path.join(getToolStateDir(toolName), 'registrations.json'));
  };
  await Promise.resolve(server.start());
  // Parent-domain certificate fallback can hide a missing exact subdomain
  // certificate. Provision registered domains through the running ACME owner.
  const { loadRegistrations } = await import('./site-registration.js');
  const registrations = await loadRegistrations(path.join(getToolStateDir(toolName), 'registrations.json'));
  for (const { domain } of registrations.sites) {
    const exactCert = path.join(config.greenlockStorePath, 'live', domain, 'cert.pem');
    if (!(await access(exactCert).then(() => true, () => false))) {
      await server._checkCertificate(domain);
    }
  }
  return server;
}

async function deployedDomains(wwwPath) {
  const entries = await readdir(wwwPath, { withFileTypes: true });
  const domains = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.includes(".")) continue;
    const hasHandler = await access(path.join(wwwPath, entry.name, "index.js")).then(() => true, () => false);
    if (hasHandler) domains.push(entry.name);
  }
  return domains.sort();
}

async function probeHttps(domain) {
  await new Promise((resolve, reject) => {
    const request = https.request({
      host: "127.0.0.1",
      port: 443,
      method: "GET",
      path: "/",
      servername: domain,
      rejectUnauthorized: true,
      headers: { host: domain }
    }, (response) => {
      response.resume();
      if (response.statusCode >= 200 && response.statusCode < 400) resolve();
      else reject(new Error(`${domain} health probe returned HTTP ${response.statusCode}`));
    });
    request.setTimeout(4000, () => request.destroy(new Error(`${domain} health probe timed out`)));
    request.once("error", reject);
    request.end();
  });
}

async function rosterHealth(config) {
  const domains = await deployedDomains(config.wwwPath);
  if (!domains.length) throw new Error(`RosterServer has no deployed sites under ${config.wwwPath}`);
  await Promise.all(domains.map(probeHttps));
  return { message: `RosterServer served ${domains.length} HTTPS site${domains.length === 1 ? "" : "s"}`, domains };
}

async function runDaemon() {
  const config = await loadConfig();
  await startRosterServer(config);
  await daemon.workLoop({
    processJob: async () => ({ wwwPath: config.wwwPath, greenlockStorePath: config.greenlockStorePath }),
    healthCheck: () => rosterHealth(config)
  });
}

async function statusAction() {
  const status = await readJson(daemon.paths.statusFile, { state: "stopped" });
  const pid = await daemon.getPid();
  return { ...status, pid: pid || null, alive: isProcessAlive(pid), paths: daemon.paths };
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

async function publishAsset(request, args, config, domain) {
  requireConfig(config, ["wwwPath"]);
  const sourcePath = request.artifact?.path;
  if (!sourcePath) throw new Error("asset needs an input artifact");
  const fileName = path.basename(String(args.fileName || "").trim());
  if (!fileName || fileName !== args.fileName) throw new Error("asset needs a safe args.fileName");
  const assetsDir = path.join(config.wwwPath, domain, "assets");
  await mkdir(assetsDir, { recursive: true });
  await copyFile(sourcePath, path.join(assetsDir, fileName));
  return { ok: true, action: "asset", domain, fileName, url: `https://${domain}/assets/${encodeURIComponent(fileName)}` };
}

async function handleRun(request) {
  const args = request.args || {};
  const action = args.action || "status";
  const config = await loadConfig(request.chatId);
  const domain = resolveDomain(args, config, { required: ["dns", "list", "init", "publish", "asset", "root-text", "static-deploy", "static-restore"].includes(action) });

  if (action === "start") return startDaemon();
  if (action === "stop") return stopDaemon();
  if (action === "status") return statusAction();
  if (action === "dns") return dnsAction(domain);
  if (action === 'register') return (await import('./site-registration.js')).registerSite({
    file: path.join(getToolStateDir(toolName), 'registrations.json'),
    backupRoot: path.join(getChatToolStateDir(request.chatId, toolName), 'registration-backups'),
    allowedRoot: path.dirname(getChatToolStateDir(request.chatId, toolName)), chatId: request.chatId,
    domain, sitePath: args.sitePath
  });
  if (action === 'audio-routes') return (await import('./audio-deploy.js')).deployAudioRoutes(config, domain);
  if (action === "asset") return publishAsset(request, args, config, domain);
  if (action === 'static-deploy') return (await import('./static-deploy.js')).deployStatic(request, config, domain);
  if (action === 'static-restore') return (await import('./static-deploy.js')).restoreStatic(request, config, domain);
  if (action === 'story-index') return (await import('./story-index.js')).publishStoryIndex(request, config, domain);
  if (action === "story-pair") return (await import('./story-pair.js')).publishStoryPair(request, config, domain);
  if (action === "root-text") return (await import("./root-text.js")).publishRootText(request, args, config, domain);

  const db = await openDb(request.chatId);
  if (action === "domains") return { ok: true, action, domains: await getKnownDomains(db, config.domain) };
  if (action === "list") return { ok: true, action, domain, pages: await getAllPages(db, domain, config.domain) };

  if (action === "page-only") {
    if (!request.chatId || !domain || !/^[a-z0-9-]+$/.test(args.slug || "") || args.slug === "home") throw new Error("Exact non-home slug, domain and chat required");
    const { rename } = await import("node:fs/promises");
    const { randomUUID } = await import("node:crypto");
    const { getChatToolStateDir } = await importCore("runtime/paths.js");
    const file = path.join(config.wwwPath, domain, "data", "pages.json");
    const original = await readFile(file, "utf8");
    const pages = JSON.parse(original);
    const html = await readInputHtml(request);
    if (!html.trim()) throw new Error("HTML required");
    const backupId = randomUUID();
    const backupDir = path.join(getChatToolStateDir(request.chatId, "roster-sites"), "page-backups", backupId);
    await mkdir(backupDir, { recursive: true });
    await writeFile(path.join(backupDir, "previous.json"), JSON.stringify({domain, slug: args.slug, page: pages.find(p => p.slug === args.slug) || null}), "utf8");
    const page = { ...(pages.find(p => p.slug === args.slug) || {}), slug: args.slug, title: args.title || args.slug, html, updatedAt: new Date().toISOString() };
    const updated = [...pages.filter(p => p.slug !== args.slug), page];
    const temporary = `${file}.${backupId}.tmp`;
    await writeFile(temporary, JSON.stringify(updated, null, 2) + "\n", "utf8");
    if (await readFile(file, "utf8") !== original) throw new Error("Concurrent page change; live pages preserved");
    await rename(temporary, file);
    await savePage(db, { domain, slug: args.slug, title: page.title, html, kind: "page" });
    return { ok: true, action, domain, slug: args.slug, backupId, url: `https://${domain}/${args.slug}`, reloadRequired: false };
  }

  if (action === "init" || action === "publish") {
    if (await access(path.join(config.wwwPath, domain, 'static-current.json')).then(() => true, () => false)) throw new Error('This domain has a static bundle; use static-deploy or static-restore instead');
    const html = await readInputHtml(request);
    if (!html.trim()) throw new Error(`${action} needs HTML text or an HTML artifact`);
    const slug = action === "init" ? "home" : slugify(args.slug || args.title || titleFromHtml(html));
    const page = await savePage(db, { domain, slug, title: args.title, html, kind: action === "init" ? "home" : "page" });
    const pages = await getAllPages(db, domain, config.domain);
    const siteDir = await deploySite(config, domain, pages);
    const daemonStatus = await startDaemon();
    return { ok: true, action, domain, url: `https://${domain}/${slug === "home" ? "" : slug}`, siteDir, daemon: { pid: daemonStatus.pid, status: daemonStatus.status }, page: { slug: page.slug, title: page.title, updatedAt: page.updatedAt } };
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
