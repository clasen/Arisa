import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const types = {
  '.html': 'text/html; charset=UTF-8', '.js': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8', '.json': 'application/json; charset=UTF-8',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=UTF-8',
  '.xml': 'application/xml; charset=UTF-8'
};

export function requestFile(url) {
  try {
    const pathname = decodeURIComponent(String(url || '/').split('?')[0]);
    const name = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    if (!name || name.includes('\\') || name.includes('\0') || name.split('/').some(p => !p || p === '.' || p === '..')) return null;
    return name;
  } catch { return null; }
}

export function createStaticHandler(root) {
  return async (req, res) => {
    const headers = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cache-control': 'no-cache' };
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { ...headers, allow: 'GET, HEAD' }); res.end(); return;
    }
    const name = requestFile(req.url);
    if (!name) { res.writeHead(403, headers); res.end(); return; }
    try {
      const current = JSON.parse(await readFile(path.join(root, 'static-current.json'), 'utf8'));
      if (!/^[a-f0-9-]+$/.test(current.release)) throw new Error('Invalid release');
      if (!current.files.includes(name)) { res.writeHead(404, headers); res.end(); return; }
      const body = await readFile(path.join(root, 'static-releases', current.release, name));
      res.writeHead(200, { ...headers, 'content-type': types[path.extname(name)] || 'application/octet-stream', 'content-length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(503, headers); res.end();
    }
  };
}

export default () => createStaticHandler(path.dirname(fileURLToPath(import.meta.url)));
