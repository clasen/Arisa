import test from 'node:test';
import assert from 'node:assert/strict';
import { action } from '../index.js';
import { createTrip, fresh } from '../domain.js';
import { flightIdentity, pendingAlerts } from '../flights.js';
import config from '../config.js';
function setup() {
 const state=fresh(),t=createTrip(state,{tripId:'demo',name:'Test',timezone:'UTC',channel:'whatsapp',destination:'123@g.us'},'99');
 const now=Date.now();t.watch={enabled:true,generation:'g'};t.flightMonitoring={enabled:true};
 const f={id:'f',kind:'flight',visibility:'shared',status:'confirmed',flightNumber:'IB108',origin:'EZE',destination:'MAD',startTimezone:'UTC',startAt:new Date(now+3600000).toISOString(),endAt:new Date(now+12*3600000).toISOString()};t.items.f=f;
 t.flightChecks={f:{identity:flightIdentity(f),lastAttempt:new Date(now).toISOString(),pending:{type:'change',changes:[{field:'arrivalTerminal',before:'4S',after:'4'}],evidence:{sourceUrl:'https://www.flightstats.com/',observedAt:new Date(now).toISOString(),verified:true}}}};
 const calls=[];const client={tasks:{add:async task=>{calls.push(task);return {id:'test-task'};}}};
 const run=a=>action({chatId:'99',resourceId:'123@g.us',args:{tripId:'demo',...a}},state,async()=>{},client,config);
 return {t,calls,client,run,now};
}
test('change pipeline creates one guarded task, claim gives evidence, finish sent blocks duplicate',async()=>{
 const {run,t,calls}=setup();let r=await run({action:'flights-check'});assert.equal(r.alerts.length,1);const id=r.alerts[0].id;
 assert.equal(calls[0].task.source.resourceId,'123@g.us');assert.equal(calls[0].task.retry.maxAttempts,1);
 r=await run({action:'flights-check'});assert.equal(r.alerts.length,0);assert.equal(calls.length,1);
 const c=await run({action:'claim',noticeId:id});assert.equal(c.permitted,true);assert.equal(c.flightEvidence.type,'change');assert.equal(c.route.destination,'123@g.us');
 await run({action:'finish',noticeId:id,token:c.token,outcome:'sent',evidence:'simulated-message-id'});
 assert.equal((await run({action:'claim',noticeId:id})).permitted,false);
});
test('uncertain scheduler outcome does not recreate flight alert',async()=>{
 const {run,client,calls}=setup();client.tasks.add=async task=>{calls.push(task);throw Error('timeout');};
 assert.equal((await run({action:'flights-check'})).alerts[0].status,'uncertain');
 assert.equal((await run({action:'flights-check'})).alerts.length,0);assert.equal(calls.length,1);
});
test('disable cancels queued alert even after re-enable',async()=>{
 const {run,t}=setup();const id=(await run({action:'flights-check'})).alerts[0].id;
 await run({action:'flights-disable'});t.flightMonitoring.enabled=true;assert.equal((await run({action:'claim',noticeId:id})).permitted,false);
});
test('quiet hours defer distant alerts but not last-day alerts',()=>{
 const {t}=setup();const night=Date.parse('2026-09-24T23:00:00Z');
 t.items.f.startAt=new Date(night+48*3600000).toISOString();t.flightChecks.f.identity=flightIdentity(t.items.f);
 assert.equal(pendingAlerts(t,night).length,0);
 t.items.f.startAt=new Date(night+6*3600000).toISOString();t.flightChecks.f.identity=flightIdentity(t.items.f);
 assert.equal(pendingAlerts(t,night).length,1);
});
