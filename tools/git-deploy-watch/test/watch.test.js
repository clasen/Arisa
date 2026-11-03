import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import * as m from '../model.js';
import {action, check} from '../index.js';
import {transact} from '../store.js';
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const config = {REPO_URL: 'https://github.com/example/site.git', BRANCH: 'master', DOMAIN: 'example.com', WORKFLOW: 'Build, verify, publish and verify destination.', CHECK_SECONDS: 300};
const state = () => ({version: 1, enabled: true, generation: 'generation', identity: m.identity(config), deployedRevision: A});

test('config excludes credentials, bad branches/domains and unbounded cadence', () => {
  assert.equal(m.validateConfig(config).CHECK_SECONDS, 300);
  for (const patch of [{REPO_URL: 'http://example.com/repo'}, {REPO_URL: 'https://secret@example.com/repo'}, {BRANCH:'--help'}, {BRANCH:'a..b'}, {DOMAIN:'example.com/path'}, {CHECK_SECONDS:0}, {WORKFLOW:''}]) assert.throws(() => m.validateConfig({...config,...patch}));
});
test('remote parser requires exact branch and full revision', () => {
  assert.equal(m.remoteRevision(`${A}\trefs/heads/master\n`, 'master'), A);
  for (const value of ['', `${A}\trefs/heads/main`, `short\trefs/heads/master`, `${A}\trefs/heads/master\n${B}\trefs/heads/master`]) assert.throws(() => m.remoteRevision(value, 'master'));
});
test('only new revisions queue and concurrent commits coalesce behind pending work', () => {
  const s = state(); assert.equal(m.queueRevision(s,A,'now'),false); assert.equal(m.queueRevision(s,B,'now'),true);
  assert.equal(m.queueRevision(s,B,'now'),false); assert.equal(m.queueRevision(s,C,'now'),false); assert.equal(s.pending.revision,B);
});
test('claims are exact, one-time, and stop when paused or obsolete', () => {
  const s=state();m.queueRevision(s,B,'now');assert.throws(() => m.claim(s,'old',B));assert.throws(() => m.claim(s,'generation',C));
  s.enabled=false;assert.throws(() => m.claim(s,'generation',B));s.enabled=true;
  const claim=m.claim(s,'generation',B);assert.ok(claim.token);assert.throws(() => m.claim(s,'generation',B));
});
test('stalled claims alert once without expiring or retrying any deployment', () => {
  const s=state();m.queueRevision(s,B,'2026-10-01T00:00:00Z');
  s.pending.status='claimed';s.pending.token='original';s.pending.claimedAt='2026-10-01T00:10:00Z';
  assert.equal(m.flagStalledClaim(s,'2026-10-01T00:39:59Z'),false);
  assert.equal(m.flagStalledClaim(s,'2026-10-01T00:40:00Z'),true);
  assert.equal(m.flagStalledClaim(s,'2026-10-02T00:00:00Z'),false);
  assert.equal(s.pending.status,'claimed');assert.equal(s.pending.token,'original');assert.equal(s.deployedRevision,A);
  assert.equal(m.queueRevision(s,C,'later'),false);
});
test('legacy claims use queued time; queued, invalid and future timestamps do not alert', () => {
  const s=state();m.queueRevision(s,B,'2026-10-01T00:00:00Z');
  assert.equal(m.flagStalledClaim(s,'2026-10-02T00:00:00Z'),false);
  s.pending.status='claimed';assert.equal(m.flagStalledClaim(s,'2026-10-01T00:30:00Z'),true);
  delete s.pending.recoveryNotifiedAt;s.pending.queuedAt='invalid';assert.equal(m.flagStalledClaim(s,'2026-10-02T00:00:00Z'),false);
  s.pending.queuedAt='2026-10-03T00:00:00Z';assert.equal(m.flagStalledClaim(s,'2026-10-02T00:00:00Z'),false);
});
test('stalled check persists its one alert before emitting a domain-bound reconciliation event', async () => {
  const s=state();m.queueRevision(s,B,new Date(Date.now()-m.STALLED_CLAIM_MS-1000).toISOString());
  s.pending.status='claimed';s.pending.token='original';let saved;
  const result=await check(s,{generation:'generation'},config,async()=>{saved=structuredClone(s);},async()=>C);
  assert.ok(saved.pending.recoveryNotifiedAt);assert.equal(saved.pending.token,'original');
  assert.equal(result.json.status,'deployment-pending');assert.equal(result.asyncTask.source.resourceId,'example.com');
  assert.match(result.asyncTask.payload.prompt,/manual reconciliation/);assert.match(result.asyncTask.payload.prompt,/Do not expire/);
  assert.equal((await check(s,{generation:'generation'},config,async()=>{},async()=>C)).asyncTask,undefined);
});
test('claims record their start time and completion removes recovery alert state', () => {
  const s=state();m.queueRevision(s,B,'old');const claim=m.claim(s,'generation',B);
  assert.ok(Number.isFinite(Date.parse(claim.claimedAt)));
  s.pending.recoveryNotifiedAt='alerted';m.finish(s,{revision:B,token:claim.token,outcome:'deployed',evidence:'verified'});
  assert.equal(s.pending,undefined);assert.equal(m.queueRevision(s,C,'now'),true);assert.equal(s.pending.recoveryNotifiedAt,undefined);
});
test('successful acknowledgement tracks actual built SHA and the next newest revision', () => {
  const s=state();m.queueRevision(s,B,'now');const claim=m.claim(s,'generation',B);
  assert.throws(() => m.finish(s,{revision:B,token:'wrong',outcome:'deployed',evidence:'HTTPS'}));
  m.finish(s,{revision:B,token:claim.token,outcome:'deployed',deployedRevision:C,evidence:'HTTPS hash verified'});
  assert.equal(s.deployedRevision,C);assert.equal(s.pending,undefined);assert.equal(m.queueRevision(s,C,'now'),false);
});
test('failed SHA is not retried, but a newer revision can queue', () => {
  const s=state();m.queueRevision(s,B,'now');const claim=m.claim(s,'generation',B);
  m.finish(s,{revision:B,token:claim.token,outcome:'failed',evidence:'Build failed; live site unchanged'});
  assert.equal(s.deployedRevision,A);assert.equal(m.queueRevision(s,B,'now'),false);assert.equal(m.queueRevision(s,C,'now'),true);
});
test('uncertain deployments block even newer commits until explicit reconciliation', () => {
  const s=state();m.queueRevision(s,B,'now');const claim=m.claim(s,'generation',B);
  m.finish(s,{revision:B,token:claim.token,outcome:'uncertain',evidence:'IPC outcome unknown'});
  assert.equal(s.blocked,true);assert.equal(m.queueRevision(s,C,'now'),false);
});
test('unchanged checks and stale generations emit no agent tasks', async () => {
  const s=state();let calls=0;const fetcher=async()=>{calls++;return A;};
  assert.equal((await check(s,{generation:'old'},config,async()=>{},fetcher)).asyncTask,undefined);assert.equal(calls,0);
  assert.equal((await check(s,{generation:'generation'},config,async()=>{},fetcher)).json.status,'no-change');assert.equal(calls,1);
});
test('checks persist pending state before emitting a single domain-bound event', async () => {
  const s=state();let saved;const checkpoint=async()=>{saved=JSON.parse(JSON.stringify(s));};
  const result=await check(s,{generation:'generation'},config,checkpoint,async()=>B);
  assert.equal(saved.pending.revision,B);assert.equal(result.asyncTask.kind,'agent_event');assert.equal(result.asyncTask.source.resourceId,'example.com');
  assert.match(result.asyncTask.payload.prompt,/action=claim/);assert.match(result.asyncTask.payload.prompt,/action=finish/);
  assert.equal((await check(s,{generation:'generation'},config,checkpoint,async()=>B)).asyncTask,undefined);
});
test('network failure stays unverified and alerts only once until recovery', async () => {
  const s=state();const fail=async()=>{throw Error('network');};
  assert.equal((await check(s,{generation:'generation'},config,async()=>{},fail)).asyncTask.kind,'agent_event');
  assert.equal((await check(s,{generation:'generation'},config,async()=>{},fail)).asyncTask,undefined);assert.equal(s.deployedRevision,A);
  await check(s,{generation:'generation'},config,async()=>{},async()=>A);assert.equal(s.lastError,undefined);
});
test('config changes invalidate polling and claims', async () => {
  const s=state();const different={...config,DOMAIN:'other.com'};assert.equal((await check(s,{generation:'generation'},different,async()=>{})).json.status,'configuration-changed-reapproval-required');
  await assert.rejects(action({args:{action:'claim',generation:'generation',revision:B}},s,async()=>{},null,different));
});
test('watch schedules only once with owner confirmation; pause blocks later claims', async () => {
  const s={version:1,enabled:false};let tasks=0;const client={tasks:{add:async({task})=>{tasks++;assert.equal(task.kind,'poll_tool');assert.equal(task.recurrence.everySeconds,300);return{id:'poll'};},cancel:async()=>{}}};
  await assert.rejects(action({args:{action:'watch',revision:A}},s,async()=>{},client,config));
  await action({args:{action:'watch',revision:A,confirm:'true'}},s,async()=>{},client,config);
  await assert.rejects(action({args:{action:'watch',revision:A,confirm:'true'}},s,async()=>{},client,config));assert.equal(tasks,1);
  m.queueRevision(s,B,'now');await action({args:{action:'pause'}},s,async()=>{},client,config);assert.equal(s.enabled,false);
  assert.throws(()=>m.claim(s,s.generation,B));
});
test('scheduling uncertainty is durable and does not invite blind retries', async () => {
  const s={version:1,enabled:false};let saved;const client={tasks:{add:async()=>{throw Error('timeout');}}};
  await assert.rejects(action({args:{action:'watch',revision:A,confirm:'true'}},s,async()=>{saved=structuredClone(s);},client,config));
  assert.equal(saved.scheduling,'uncertain');await assert.rejects(action({args:{action:'watch',revision:A,confirm:'true'}},s,async()=>{},client,config));
});
test('state is atomic and chat directories are independent; concurrent writes reject', async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'git-deploy-watch-test-'));
  try {await transact(path.join(root,'one'),async(s,save)=>{s.deployedRevision=A;await save();await assert.rejects(transact(path.join(root,'one'),async()=>{}));});
    await transact(path.join(root,'two'),async(s,save)=>{assert.equal(s.deployedRevision,undefined);s.deployedRevision=B;await save();});
    assert.equal(JSON.parse(await readFile(path.join(root,'one','state.json'),'utf8')).deployedRevision,A);
  }finally{await rm(root,{recursive:true,force:true});}
});
