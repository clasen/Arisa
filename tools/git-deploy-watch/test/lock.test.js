import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {transact} from '../store.js';

async function fixture(work) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-lock-test-'));
  try { await work(dir); } finally { await fs.rm(dir, {recursive:true,force:true}); }
}
test('dead legacy owner is recovered without losing pending claims', () => fixture(async dir => {
  await fs.writeFile(path.join(dir,'state.lock'),JSON.stringify({pid:2147483647}));
  await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({version:1,pending:{token:'preserve'}}));
  await transact(dir,async(s,save)=>{assert.equal(s.pending.token,'preserve');await save();});
}));
test('live and malformed legacy owners are never stolen', () => fixture(async dir => {
  for(const contents of [JSON.stringify({pid:process.pid}),'{']) {
    await fs.writeFile(path.join(dir,'state.lock'),contents);
    await assert.rejects(transact(dir,async()=>assert.fail('must not enter')));
    assert.equal(await fs.readFile(path.join(dir,'state.lock'),'utf8'),contents);
  }
}));
test('exceptions release mutex and concurrent transactions cannot enter', () => fixture(async dir => {
  await assert.rejects(transact(dir,async()=>{
    await assert.rejects(transact(dir,async()=>assert.fail('concurrent entry')));
    throw Error('work failed');
  }),/work failed/);
  await transact(dir,async(s,save)=>{s.ok=true;await save();});
}));
test('SIGKILL releases OS lock and next transaction recovers metadata', () => fixture(async dir => {
  const moduleUrl=new URL('../store.js',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {transact} from ${JSON.stringify(moduleUrl)}; await transact(${JSON.stringify(dir)},async(s,save)=>{s.pending={revision:'kept'};await save();process.stdout.write('ready\\n');await new Promise(()=>{});});`],{stdio:['ignore','pipe','pipe']});
  // Keep the work process alive while its lock holder is waiting on stdin.
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('child exited early')));});
  await assert.rejects(transact(dir,async()=>assert.fail('lock stolen')));
  child.kill('SIGKILL');await once(child,'exit');
  await new Promise(resolve=>setTimeout(resolve,100));
  await transact(dir,async(s,save)=>{assert.equal(s.pending.revision,'kept');await save();});
}));
