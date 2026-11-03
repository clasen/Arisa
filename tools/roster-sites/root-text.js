import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const names = new Set(["robots.txt", "llms.txt", "sitemap.xml"]);
const anchor = '    const pages = await loadPages();';
const routeBlock = `    // roster-root-text-v2
    if (["/robots.txt", "/llms.txt", "/sitemap.xml"].includes(pathname)) {
      try {
        const body = await readFile(path.join(root, pathname.slice(1)));
        const contentType = pathname === "/sitemap.xml" ? "application/xml; charset=utf-8" : "text/plain; charset=utf-8";
        res.writeHead(200, { "content-type": contentType, "cache-control": "public, max-age=300" });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      } catch (error) {
        if (error.code === "ENOENT") return notFound(res);
        throw error;
      }
    }
`;
export function withRootTextRoutes(source) {
  if (source.includes('// roster-root-text-v2')) return source;
  if (!source.includes(anchor)) throw new Error("Site handler layout is not supported");
  if (source.includes('// roster-root-text')) {
    const legacy = /    \/\/ roster-root-text\n[\s\S]*?(?=    const pages = await loadPages\(\);)/;
    if (!legacy.test(source)) throw new Error("Legacy root route layout is not supported");
    return source.replace(legacy, routeBlock);
  }
  return source.replace(anchor, routeBlock + anchor);
}

export async function publishRootText(request, args, config, domain) {
  if (!config.wwwPath) throw new Error("wwwPath is required");
  if (!names.has(args.fileName)) throw new Error("fileName must be robots.txt, llms.txt, or sitemap.xml");
  const text = request.artifact?.path ? await readFile(request.artifact.path, "utf8") : String(request.text || request.artifact?.text || "");
  if (!text.trim()) throw new Error("Nonempty text is required");
  const clean = text.replace(/^\ufeff/, '');
  if (args.fileName === "sitemap.xml" && (!clean.startsWith('<?xml version="1.0" encoding="UTF-8"?>') || !clean.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">') || !clean.trimEnd().endsWith('</urlset>'))) {
    throw new Error("Expected a UTF-8 XML sitemap urlset");
  }
  const siteDir = path.join(config.wwwPath, domain);
  const handlerPath = path.join(siteDir, "index.js");
  const source = await readFile(handlerPath, "utf8");
  const updated = withRootTextRoutes(source);
  await writeFile(path.join(siteDir, args.fileName), (args.fileName.endsWith('.txt') ? '\ufeff' : '') + clean, "utf8");
  if (updated !== source) await writeFile(handlerPath, updated, "utf8");
  return { ok: true, url: `https://${domain}/${args.fileName}`, reloadRequired: updated !== source };
}
