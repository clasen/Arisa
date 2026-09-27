import {test} from 'node:test';
import { action } from '../index.js';
import { createTrip, fresh, putItem } from '../domain.js';
import config from '../config.js';
import assert from 'node:assert/strict';
import {bindWeather,checkWeather,pendingWeather,weatherClaimValid,analyzeWeather} from '../weather.js';
const now=Date.parse('2026-09-25T12:00:00Z');
const binding={itemId:'stay',label:'Test coast',latitude:39,longitude:0,timezone:'Europe/Madrid',from:'2026-09-25',to:'2026-09-29'};
function trip(){const t={active:true,items:{stay:{id:'stay',status:'confirmed',visibility:'shared'}},watch:{enabled:true,generation:'a'},timezone:'UTC',quietStart:22,quietEnd:8};bindWeather(t,[binding]);return t;}
function data(){return {timezone:'Europe/Madrid',daily_units:{temperature_2m_max:'°C',precipitation_sum:'mm',wind_gusts_10m_max:'km/h',precipitation_probability_max:'%'},daily:{time:['2026-09-25','2026-09-26','2026-09-28'],temperature_2m_max:[36,20,40],precipitation_probability_max:[0,80,90],precipitation_sum:[0,8,20],wind_gusts_10m_max:[10,55,60],weather_code:[0,95,95]}};}
test('useful risks only in near local dates',()=>{const rows=analyzeWeather(binding,data(),now);assert.equal(rows.length,2);assert.deepEqual(rows[0].risks,['heat']);assert.deepEqual(rows[1].risks,['rain','wind','thunderstorm']);});
test('null and wrong units fail closed',()=>{const d=data();d.daily.temperature_2m_max[0]=null;assert.throws(()=>analyzeWeather(binding,d,now));d.daily.temperature_2m_max[0]=30;d.daily_units.wind_gusts_10m_max='mph';assert.throws(()=>analyzeWeather(binding,d,now));});
test('checkpoint cadence, quiet time, failure preserves last verified without alert',async()=>{const t=trip();let calls=0;const fetcher=async()=>{calls++;return data();};await checkWeather(t,now,async()=>{},fetcher);assert.equal(pendingWeather(t,now).length,1);await checkWeather(t,now+1000,async()=>{},fetcher);assert.equal(calls,1);assert.equal(pendingWeather(t,Date.parse('2026-09-25T23:00Z')).length,0);await checkWeather(t,now+12*3600000,async()=>{},async()=>{throw Error();});assert.equal(t.weather.checks.stay.lastResult.verified,false);assert.ok(t.weather.checks.stay.lastVerified);assert.equal(t.weather.checks.stay.pending,null);});
test('claim blocks changed itinerary, disabled watch and newer evidence',async()=>{const t=trip();await checkWeather(t,now,async()=>{},async()=>data());const n={itemId:'stay',watchGeneration:'a',weatherIdentity:t.weather.bindings[0].identity,weatherEvidence:t.weather.checks.stay.pending};assert.ok(weatherClaimValid(t,n,now));t.items.stay.title='changed';assert.ok(!weatherClaimValid(t,n,now));delete t.items.stay.title;t.watch.enabled=false;assert.ok(!weatherClaimValid(t,n,now));t.watch.enabled=true;t.weather.checks.stay.lastResult.observedAt='2026-09-25T13:00Z';assert.ok(!weatherClaimValid(t,n,now));});
test('private and malformed bindings rejected atomically',()=>{const t=trip();t.items.stay.visibility='private';assert.throws(()=>bindWeather(t,[binding]));assert.throws(()=>bindWeather(trip(),[{...binding,latitude:100}]));});
test('full simulated poll, claim, finish and no duplicate scheduling',async()=>{
  const originalNow=Date.now, originalFetch=globalThis.fetch;
  Date.now=()=>now;
  globalThis.fetch=async()=>new Response(JSON.stringify(data()),{status:200});
  try {
    const state=fresh(); const t=createTrip(state,{tripId:'test',name:'Test',timezone:'UTC',channel:'telegram',destination:'1'},'1');
    putItem(t,{id:'stay',title:'Coast',kind:'stay',status:'confirmed'});
    const tasks=[]; const client={tasks:{add:async x=>{tasks.push(x);return {id:String(tasks.length)};}}};
    const run=args=>action({chatId:'1',args:{tripId:'test',...args}},state,async()=>{},client,config);
    await run({action:'weather-enable',confirm:'true',data:JSON.stringify([binding])});
    const out=await run({action:'weather-check'});assert.equal(out.alerts.length,1);
    assert.match(tasks[1].task.payload.prompt,/weatherEvidence/);
    const id=out.alerts[0].id;
    const claim=await run({action:'claim',noticeId:id});assert.ok(claim.permitted);assert.ok(claim.weatherEvidence);
    assert.equal((await run({action:'claim',noticeId:id})).permitted,false);
    await run({action:'finish',noticeId:id,token:claim.token,outcome:'sent',evidence:'simulated-id'});
    assert.equal((await run({action:'weather-check'})).alerts.length,0);
    assert.equal(tasks.length,2);
  } finally {Date.now=originalNow;globalThis.fetch=originalFetch;}
});
test('already notified date-risk combinations stay silent',async()=>{const t=trip();t.weather.checks.stay={notified:['2026-09-25:heat','2026-09-26:rain','2026-09-26:wind','2026-09-26:thunderstorm']};await checkWeather(t,now,async()=>{},async()=>data());assert.equal(t.weather.checks.stay.pending,null);});
