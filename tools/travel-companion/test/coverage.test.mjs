import test from 'node:test';
import assert from 'node:assert/strict';
import { action } from '../index.js';
import { fresh, createTrip, putItem, view, noticePrompt, claimNotice } from '../domain.js';
import config from '../config.js';
const source = '11111111-1111-1111-1111-111111111111';
const evidence = '22222222-2222-2222-2222-222222222222';
function setup(visibility = 'shared') {
  const state = fresh();
  const trip = createTrip(state, {tripId:'demo', name:'Demo', timezone:'UTC', channel:'whatsapp', destination:'123@g.us'}, '99');
  putItem(trip, {id:'stay', kind:'stay', title:'Stay', visibility, sourceArtifactId:source});
  const client = {artifacts:{get:async () => ({ok:true})}};
  const run = (actionName, data, resourceId = '123@g.us') => action({chatId:'99', resourceId, args:{action:actionName,tripId:'demo',itemId:'stay',data}},state,async()=>{},client,config);
  return {trip,run,client};
}
const full = () => ({textStatus:'complete', textEvidenceArtifactId:evidence, topics:['parking'], resources:[{id:'entrance',kind:'video',status:'detected'}]});
test('legacy state is unread, not implicitly reviewed',async()=>{
  const {run,trip}=setup();
  const result=await run('document-check',{topics:['parking']});
  assert.equal(result.ready,false);assert.equal(result.textStatus,'unread');
  assert.deepEqual(view(trip).documentReviews,[]);
});
test('detected/blocked videos never count as reviewed, irrelevant media need not block text answers',async()=>{
  const {run}=setup();
  await run('document-review',full());
  assert.equal((await run('document-check',{topics:['parking']})).ready,true);
  assert.equal((await run('document-check',{resources:['entrance']})).ready,false);
  const data=full();data.resources[0].status='blocked';await run('document-review',data);
  assert.equal((await run('document-check',{resources:['entrance']})).ready,false);
  data.resources[0]={...data.resources[0],status:'reviewed',evidenceArtifactId:evidence};await run('document-review',data);
  assert.equal((await run('document-check',{topics:['parking'],resources:['entrance']})).ready,true);
});
test('partial reading blocks preflight; missing topics remain explicit',async()=>{
  const {run}=setup();const data=full();data.textStatus='partial';await run('document-review',data);
  assert.equal((await run('document-check',{topics:['parking']})).ready,false);
  await run('document-review',full());
  assert.deepEqual((await run('document-check',{topics:['wifi']})).missingTopics,['wifi']);
});
test('reviewed evidence is mandatory; validation/artifact failure leaves state unchanged',async()=>{
  const {run,trip,client}=setup();const data=full();data.resources[0].status='reviewed';
  await assert.rejects(run('document-review',data));assert.equal(trip.documentReviews,undefined);
  client.artifacts.get=async()=>null;await assert.rejects(run('document-review',full()));assert.equal(trip.documentReviews,undefined);
});
test('metadata rejects URLs, secret fields, duplicates and empty preflight',async()=>{
  const {run}=setup();
  for(const data of [{...full(),url:'https://private.example'},{...full(),topics:['door code 123456']},{...full(),resources:[full().resources[0],full().resources[0]]},{textStatus:'unread',topics:['parking']}]) await assert.rejects(run('document-review',data));
  await assert.rejects(run('document-check',{}));
});
test('source replacement invalidates review without resurrection; same-source status edit retains it',async()=>{
  const {run,trip}=setup();await run('document-review',full());const item=trip.items.stay;
  putItem(trip,{...item,status:'confirmed'});assert.equal((await run('document-check',{topics:['parking']})).ready,true);
  putItem(trip,{...item,sourceArtifactId:evidence});assert.equal((await run('document-check',{topics:['parking']})).ready,false);
  putItem(trip,item);assert.equal((await run('document-check',{topics:['parking']})).ready,false);
});
test('resource mismatch and private review operations cannot leak to groups',async()=>{
  const {run,trip}=setup('private');
  await assert.rejects(run('document-review',full()));await assert.rejects(run('document-check',{topics:['parking']}));
  await run('document-review',full(),'');assert.equal(view(trip).documentReviews.length,0);assert.equal(view(trip,true).documentReviews.length,1);
  await assert.rejects(run('document-check',{topics:['parking']},'999@g.us'));
});
test('idempotent reviews and full replacements do not retain stale resource claims',async()=>{
  const {run,trip}=setup();await run('document-review',full());const revision=trip.revision;
  await run('document-review',full());assert.equal(trip.revision,revision);
  await run('document-review',{textStatus:'unread'});assert.equal((await run('document-check',{topics:['parking']})).ready,false);
});
test('queued and claimed reviews include coverage safeguards',()=>{
  const {trip}=setup();trip.watch={enabled:true};
  const notice={id:'review',kind:'review',status:'scheduled',runAt:new Date().toISOString()};trip.notices.review=notice;
  assert.match(noticePrompt(trip,notice),/detected link is not viewed media/);
  const result=claimNotice(trip,'review',Date.now(),config);
  assert.match(result.deliveryInstructions,/document-check/);
  assert.match(result.trip.documentInstructions,/secrets/);
});
