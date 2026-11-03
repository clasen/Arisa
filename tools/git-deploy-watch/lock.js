import {spawn} from 'node:child_process';
import {readFile, unlink} from 'node:fs/promises';
import path from 'node:path';

// The OS owns this lock. Closing stdin (including on agent SIGKILL) makes
// the holder exit. Never unlink state.flock: its stable inode is the mutex.
export async function acquireLock(dir) {
  const holder = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '--no-fork',
    path.join(dir, 'state.flock'), process.execPath, '-e',
    "process.stdout.write('ready\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));"],
    {stdio: ['pipe', 'pipe', 'pipe']});
  holder.stdin.on('error', () => {});
  holder.stderr.resume();
  const exited = new Promise(resolve => {
    holder.once('exit', (code, signal) => resolve({code, signal}));
    holder.once('error', () => resolve({code: null}));
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { holder.kill(); reject(Error('Watcher lock acquisition timed out')); }, 5000);
      let text = '';
      holder.stdout.on('data', chunk => {
        text += chunk;
        if (text.includes('ready\n')) { clearTimeout(timer); resolve(); }
      });
      holder.once('error', () => { clearTimeout(timer); reject(Error('OS lock unavailable; flock is required')); });
      holder.once('exit', code => { clearTimeout(timer); reject(Error(code === 75 ? 'Watcher state is locked by an active transaction' : 'OS lock holder exited before acquisition')); });
    });
  } catch (error) {
    holder.stdin.end();
    throw error;
  }
  return {
    assertHeld() { if (holder.exitCode !== null || holder.signalCode !== null) throw Error('Watcher OS lock was lost'); },
    async release() { holder.stdin.end(); await exited; }
  };
}

// Migration from the previous file-only mutex. An absent PID is evidence
// of an abandoned lock; age alone is not. EPERM or malformed data fail closed.
export async function clearAbandonedLegacyLock(file) {
  let owner;
  try { owner = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return; throw Error('Cannot verify legacy watcher lock ownership'); }
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw Error('Cannot verify legacy watcher lock PID');
  try { process.kill(owner.pid, 0); }
  catch (e) {
    if (e.code === 'ESRCH') { await unlink(file); return; }
    throw Error('Cannot verify legacy watcher lock process');
  }
  throw Error('Watcher state is locked by a live legacy process');
}
