import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as d from '../domain.js';
import { transact } from '../store.js';
import config from '../config.js';

const now = Date.parse('2026-09-24T12:00:00Z');
function trip() {
  const s = d.fresh();
  return d.createTrip(s, {tripId:'demo',name:'Demo',timezone:'Europe/Madrid',channel:'whatsapp',destination:'123@g.us'}, '99');
}
function notice(t) { const n = d.addNotice(t,{id:'notice',runAt:'2026-09-24T12:01:00Z',message:'Reminder'},now); n.status='scheduled'; return n; }
test('ids reject traversal and prototype names',()=>{
  for(const x of ['../demo','__proto__','constructor','prototype','toString','bad space']) assert.throws(()=>d.key(x));
});
test('explicit offsets required',()=>{
  assert.throws(()=>d.instant('2026-09-24T14:00:00'));
  assert.throws(()=>d.instant('2026-02-30T14:00:00Z'));
  assert.equal(d.instant('2026-09-24T14:00:00+02:00'),'2026-09-24T12:00:00.000Z');
});
test('timezone rejects unknown zone',()=>assert.throws(()=>d.zone('Not/AZone')));
test('routes validate exact WhatsApp ids',()=>{
  assert.equal(d.route('whatsapp','123-456@g.us','99').destination,'123-456@g.us');
  assert.throws(()=>d.route('whatsapp','some group','99'));
});
test('Telegram destination limited to owning chat',()=>{
  assert.equal(d.route('telegram','99','99').channel,'telegram');
  assert.throws(()=>d.route('telegram','100','99'));
});
test('trip resource cannot cross another group',()=>{
  const t=trip(); assert.throws(()=>d.getTrip({trips:{demo:t}},'demo','456@g.us'));
});
test('separate state objects do not share trip data',()=>{
  const a=d.fresh(),b=d.fresh();a.trips.demo=trip();assert.throws(()=>d.getTrip(b,'demo'));
});
test('put is idempotent; update keeps provenance history',()=>{
  const t=trip(),i={id:'hotel',kind:'stay',title:'Hotel',sourceArtifactId:'075fc23e-e5a2-4558-b22b-1def7b8d91aa'};
  d.putItem(t,i);const r=t.revision;d.putItem(t,i);assert.equal(t.revision,r);
  d.putItem(t,{...i,title:'Updated hotel'});assert.equal(t.history[0].item.title,'Hotel');
});
test('unknown fields including credentials are not persisted',()=>{
  const i=d.normalizeItem({id:'hotel',kind:'stay',title:'Hotel',pin:'1234',passport:'secret'});
  assert.equal(i.pin,undefined);assert.equal(i.passport,undefined);
});
test('view excludes private records',()=>{
  const t=trip();d.putItem(t,{id:'secret',kind:'task',title:'Private',visibility:'private'});
  assert.equal(d.view(t).items.length,0);assert.equal(d.view(t,true).items.length,1);
});
test('currency validation; no inferred paid status',()=>{
  assert.throws(()=>d.normalizeItem({id:'a',kind:'car',title:'Car',amount:10}));
  assert.equal(d.normalizeItem({id:'a',kind:'car',title:'Car',amount:10,currency:'EUR'}).paid,undefined);
});
test('invalid time ranges rejected',()=>assert.throws(()=>d.normalizeItem({id:'a',kind:'flight',title:'Flight',startAt:'2026-10-01T00:00Z',endAt:'2026-09-30T00:00Z'})));
test('maps link encodes address, not a claim of coordinates',()=>assert.ok(d.mapsLink('Madrid & Toledo').endsWith('Madrid%20%26%20Toledo')));
test('flight observations need source, time, and flight item',()=>{
 const t=trip();d.putItem(t,{id:'flight',kind:'flight',title:'Flight'});
 assert.throws(()=>d.observeFlight(t,{itemId:'flight',observedAt:'2026-09-25T12:00Z',sourceUrl:'https://example.com',status:'scheduled'},now));
 const o=d.observeFlight(t,{itemId:'flight',observedAt:'2026-09-24T11:00Z',sourceUrl:'https://example.com',status:'scheduled'},now);
 assert.equal(o.observedAt,'2026-09-24T11:00:00.000Z');
 assert.throws(()=>d.observeFlight(t,{itemId:'flight',observedAt:'2026-09-24T10:00Z',sourceUrl:'https://example.com',status:'old'},now));
 d.putItem(t,{...t.items.flight,status:'confirmed'});assert.deepEqual(t.items.flight.observation,o);
});
test('duplicate reminder ids and past times rejected',()=>{
 const t=trip();notice(t);assert.throws(()=>notice(t));
 assert.throws(()=>d.addNotice(t,{id:'past',runAt:'2026-09-23T12:00Z',message:'Old'},now));
});
test('early claims denied; one successful claim only',()=>{
 const t=trip();notice(t);assert.equal(d.claimNotice(t,'notice',now,config).permitted,false);
 const c=d.claimNotice(t,'notice',now+60000,config);assert.equal(c.permitted,true);
 assert.equal(d.claimNotice(t,'notice',now+60000,config).permitted,false);
 assert.throws(()=>d.finishNotice(t,{noticeId:'notice',token:'wrong',outcome:'sent',evidence:'id'}));
 d.finishNotice(t,{noticeId:'notice',token:c.token,outcome:'sent',evidence:'message-id'});
 assert.equal(d.claimNotice(t,'notice',now+60000,config).permitted,false);
});
test('expired reminder is not sent after extended outage',()=>{
 const t=trip();notice(t);assert.equal(d.claimNotice(t,'notice',now+7200000,config).reason,'expired');
});
test('pause and cancellation prevent claims',()=>{
 const t=trip();notice(t);t.active=false;assert.equal(d.claimNotice(t,'notice',now+60000,config).permitted,false);
 t.active=true;t.notices.notice.status='cancelled';assert.equal(d.claimNotice(t,'notice',now+60000,config).permitted,false);
});
test('uncertain send remains blocked',()=>{
 const t=trip();notice(t);const c=d.claimNotice(t,'notice',now+60000,config);
 d.finishNotice(t,{noticeId:'notice',token:c.token,outcome:'uncertain'});
 assert.equal(d.claimNotice(t,'notice',now+60000,config).permitted,false);
});
test('review observes date horizon, quiet hours, interval, unresolved work',()=>{
 const t=trip();t.watch={enabled:true};d.putItem(t,{id:'flight',kind:'flight',title:'Flight',startAt:'2026-10-01T12:00Z'});
 assert.equal(d.reviewDue(t,now,config),true);
 assert.equal(d.reviewDue(t,Date.parse('2026-09-24T23:00Z'),config),false);
 t.lastReviewAt=new Date(now).toISOString();assert.equal(d.reviewDue(t,now+60000,config),false);
 t.lastReviewAt=null;t.notices.r={kind:'review',status:'scheduled'};assert.equal(d.reviewDue(t,now,config),false);
});
test('private data does not trigger or fingerprint group review',()=>{
 const t=trip();t.watch={enabled:true};const fp=d.reviewFingerprint(t,now);
 d.putItem(t,{id:'flight',kind:'flight',title:'Private Flight',visibility:'private',startAt:'2026-10-01T12:00Z'});
 assert.equal(d.reviewDue(t,now,config),false);assert.equal(d.reviewFingerprint(t,now),fp);
});
test('stopped watch blocks already queued review',()=>{
 const t=trip();t.watch={enabled:false};t.notices.review={id:'review',kind:'review',status:'scheduled',runAt:new Date(now).toISOString()};
 assert.equal(d.claimNotice(t,'review',now,config).permitted,false);
});
test('state writes are serialized and private, corrupt data fails closed',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'travel-test-'));
 try{
  await Promise.all(Array.from({length:5},(_,i)=>transact(dir,async(s,save)=>{s.trips['trip'+i]={id:i};await save();})));
  const file=path.join(dir,'state.json');assert.equal(Object.keys(JSON.parse(await readFile(file,'utf8')).trips).length,5);
  assert.equal((await stat(file)).mode & 0o777,0o600);
  await writeFile(file,'invalid json');await assert.rejects(transact(dir,async()=>{}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
