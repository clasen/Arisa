import test from 'node:test';
import assert from 'node:assert/strict';
import { action } from '../index.js';
import { fresh, createTrip } from '../domain.js';
import config from '../config.js';
function setup() {
 const state=fresh();const trip=createTrip(state,{tripId:'demo',name:'Demo',timezone:'UTC',channel:'whatsapp',destination:'123@g.us'},'99');
 const calls=[];const client={artifacts:{get:async()=>({id:'artifact'})},tasks:{add:async x=>{calls.push(x);return{id:'task-'+calls.length};},cancel:async x=>{calls.push(x);}}};
 const run=(args,resourceId='123@g.us')=>action({chatId:'99',resourceId,args:{tripId:'demo',...args}},state,async()=>{},client,config);
 return{state,trip,calls,client,run};
}
test('scheduler success retained; duplicate mutation blocked',async()=>{
 const {run,calls}=setup();const args={action:'remind',data:JSON.stringify({id:'r',message:'Hello',runAt:new Date(Date.now()+3600000).toISOString()})};
 const r=await run(args);assert.equal(r.status,'scheduled');assert.equal(r.taskId,'task-1');
 await assert.rejects(run(args));assert.equal(calls.length,1);
 assert.equal(calls[0].task.retry.maxAttempts,1);
});
test('scheduling timeout never blindly repeats',async()=>{
 const {run,client,trip}=setup();client.tasks.add=async()=>{throw new Error('timeout');};
 const args={action:'remind',data:JSON.stringify({id:'r',message:'Hello',runAt:new Date(Date.now()+3600000).toISOString()})};
 const r=await run(args);assert.equal(r.status,'uncertain');assert.equal(trip.notices.r.status,'uncertain');await assert.rejects(run(args));
});
test('batch validates every entry before mutation',async()=>{
 const {run,trip}=setup();await assert.rejects(run({action:'put-many',data:JSON.stringify([{id:'a',kind:'task',title:'Valid'},{id:'b',kind:'bad',title:'Invalid'}])}));
 assert.equal(Object.keys(trip.items).length,0);
});
test('group cannot create private items',async()=>{
 const {run}=setup();await assert.rejects(run({action:'put',data:JSON.stringify({id:'secret',kind:'flight',title:'Private',visibility:'private'})}));
});
test('explicit owner invocation supports private items, group mutations fail',async()=>{
 const {run}=setup();await run({action:'put',data:JSON.stringify({id:'secret',kind:'flight',title:'Private',visibility:'private'})},'');
 await assert.rejects(run({action:'show',includePrivate:'true',ownerConfirmed:'true'}));
 await assert.rejects(run({action:'set-status',itemId:'secret',status:'done'}));
 await assert.rejects(run({action:'put',data:JSON.stringify({id:'secret',kind:'task',title:'Overwrite'})}));
 assert.equal((await run({action:'show'})).items.length,0);
});
test('watch schedules once; pause invalidates and cancels only own watcher',async()=>{
 const {run,trip,calls}=setup();await run({action:'watch',confirm:'true'});await run({action:'watch',confirm:'true'});assert.equal(calls.length,1);
 const generation=trip.watch.generation;await run({action:'pause'});assert.equal(trip.active,false);assert.equal(trip.watch.enabled,false);assert.deepEqual(calls[1],{id:'task-1'});
 assert.equal((await run({action:'tick',generation})).status,'no-change');
});
test('uncertain watch cannot be duplicated',async()=>{
 const {run,client,calls}=setup();client.tasks.add=async x=>{calls.push(x);throw new Error('timeout');};
 assert.equal((await run({action:'watch',confirm:'true'})).status,'uncertain');await run({action:'watch',confirm:'true'});assert.equal(calls.length,1);
});
test('cancelled notice stays cancelled even if cancellation IPC fails',async()=>{
 const {run,trip,client}=setup();trip.notices.n={id:'n',status:'scheduled',taskId:'task-1'};client.tasks.cancel=async()=>{throw new Error('timeout');};
 await assert.rejects(run({action:'cancel-notice',noticeId:'n'}));assert.equal(trip.notices.n.status,'cancelled');
});
