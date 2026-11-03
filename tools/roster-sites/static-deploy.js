import { cp, mkdir, readFile, rename, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function validateBundle(bundle) {
  if (!Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 2000) throw new Error('Expected 1-2000 static files');
  const files = new Map();
  let bytes = 0;
  for (const file of bundle.files) {
    const name = file.path;
    if (typeof name !== 'string' || name.length > 240 || !/^[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.')) || name === 'index.js' || name === 'package.json') throw new Error('Unsafe static file path');
    if (files.has(name) || typeof file.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new Error('Duplicate file or invalid base64');
    const body = Buffer.from(file.base64, 'base64');
    bytes += body.length;
    if (bytes > 64 * 1024 * 1024) throw new Error('Static bundle exceeds 64 MiB');
    files.set(name, body);
  }
  if (!files.get('index.html')?.length) throw new Error('Static bundle needs index.html');
  return { files, bytes };
}

function checkDomain(domain) {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('Invalid domain');
}

async function atomicJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporary, file);
}

async function saveRelease(root, release, files) {
  const releaseDir = path.join(root, 'static-releases', release);
  for (const [name, body] of files) {
    const destination = path.join(releaseDir, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, body, { flag: 'wx' });
  }
}

export async function readBundle(request) {
  const maxBytes = 90 * 1024 * 1024;
  let text = request.artifact?.text ?? request.text;
  if (request.artifact?.path) {
    if ((await stat(request.artifact.path)).size > maxBytes) throw new Error('Bundle artifact too large');
    text = await readFile(request.artifact.path, 'utf8');
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('static-deploy needs a JSON bundle artifact');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Bundle artifact too large');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

export async function deployStatic(request, config, domain) {
  checkDomain(domain);
  if (!request.chatId || !config.wwwPath) throw new Error('static-deploy needs chatId and wwwPath');
  const bundle = await readBundle(request);
  const { files, bytes } = validateBundle(bundle);
  const { getChatToolStateDir } = await import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, 'src/runtime/paths.js')).href);
  const root = path.join(config.wwwPath, domain);
  await stat(path.join(root, 'index.js')); // Existing authorized domain only.
  const release = crypto.randomUUID();
  const backupId = `${domain}-${release}`;
  const backupDir = path.join(getChatToolStateDir(request.chatId, 'roster-sites'), 'backups', backupId);
  await mkdir(path.dirname(backupDir), { recursive: true });
  await cp(root, backupDir, { recursive: true, errorOnExist: true, force: false });
  await saveRelease(root, release, files);
  const handlerPath = new URL('./static-handler.js', import.meta.url);
  const source = await readFile(handlerPath, 'utf8');
  const existing = await readFile(path.join(root, 'index.js'), 'utf8');
  await writeFile(path.join(root, 'index.js'), source, 'utf8');
  await atomicJson(path.join(root, 'static-current.json'), {
    release, files: [...files.keys()], revision: String(bundle.revision || '').slice(0, 200),
    deployedAt: new Date().toISOString(), sourceArtifactId: request.artifact.id || null, backupId
  });
  return { ok: true, action: 'static-deploy', domain, url: `https://${domain}/`, release, backupId, files: files.size, bytes, revision: bundle.revision || null, reloadRequired: existing !== source };
}

export async function restoreStatic(request, config, domain) {
  checkDomain(domain);
  const backupId = String(request.args?.backupId || '');
  if (!request.chatId || !backupId.startsWith(`${domain}-`) || !/^[a-z0-9.-]+$/.test(backupId)) throw new Error('Invalid backupId');
  const { getChatToolStateDir } = await import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, 'src/runtime/paths.js')).href);
  const backup = path.join(getChatToolStateDir(request.chatId, 'roster-sites'), 'backups', backupId);
  const root = path.join(config.wwwPath, domain);
  await stat(path.join(backup, 'index.js'));
  // Restore in place; retained newer release files are unreachable from the previous handler.
  await cp(backup, root, { recursive: true, force: true });
  if (!(await stat(path.join(backup, 'static-current.json')).then(() => true, () => false))) await rm(path.join(root, 'static-current.json'), { force: true });
  return { ok: true, action: 'static-restore', domain, backupId, reloadRequired: true };
}
