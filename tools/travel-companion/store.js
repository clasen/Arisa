import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function save(file, data) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await (await open(tmp, 'wx', 0o600)).close();
    const handle = await open(tmp, 'w');
    try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(tmp, file);
  } finally { await unlink(tmp).catch(() => {}); }
}

export async function transact(dir, work) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'state.lock');
  let handle;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { handle = await open(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!handle) throw new Error('Trip store is locked. Retry later; do not delete a live lock. A crashed writer requires lock-owner inspection.');
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const file = path.join(dir, 'state.json');
    let state;
    try { state = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = { version: 1, trips: {} }; }
    if (state.version !== 1 || !state.trips) throw new Error('Unsupported or corrupt trip state');
    return await work(state, () => save(file, state));
  } finally { await handle.close(); await unlink(lock); }
}
