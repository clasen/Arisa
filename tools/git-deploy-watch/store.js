import {mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {acquireLock, clearAbandonedLegacyLock} from './lock.js';

export async function transact(dir, work) {
  await mkdir(dir, {recursive: true, mode: 0o700});
  const lock = path.join(dir, 'state.lock');
  const guard = await acquireLock(dir);
  let owner;
  try {
    await clearAbandonedLegacyLock(lock);
    owner = await open(lock, 'wx', 0o600);
    await owner.writeFile(JSON.stringify({pid: process.pid, at: new Date().toISOString()}));
    const file = path.join(dir, 'state.json');
    let state;
    try { state = JSON.parse(await readFile(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; state = {version: 1, enabled: false}; }
    if (state.version !== 1) throw Error('Unsupported watcher state');
    const checkpoint = async () => {
      guard.assertHeld();
      const tmp = file + '.' + crypto.randomUUID() + '.tmp';
      try {
        const handle = await open(tmp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(state, null, 2), 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        guard.assertHeld();
        await rename(tmp, file);
      } finally { await unlink(tmp).catch(() => {}); }
    };
    return await work(state, checkpoint);
  } finally {
    try { if (owner) { await owner.close(); await unlink(lock); } }
    finally { await guard.release(); }
  }
}
