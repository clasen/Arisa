import test from 'node:test';
import assert from 'node:assert/strict';
import {checkRecommendation,sendRecommendation} from '../recommendations.js';
import {noticePrompt,claimNotice} from '../domain.js';
import {weatherUrl} from '../weather.js';
const now=Date.parse('2026-10-11T12:00:00Z');
const input={itemId:'plan',label:'Cabo de Palos',latitude:37.63,longitude:-0.69,timezone:'Europe/Madrid',date:'2026-10-12',exposure:'outdoor',logisticsArtifactId:'a',coordinatesArtifactId:'b'};
const trip=()=>({active:true,route:{channel:'whatsapp',destination:'exact@g.us'},items:{plan:{id:'plan',visibility:'shared',status:'proposed'}}});
const forecast=(gust=10)=>({timezone:'Europe/Madrid',daily_units:{uv_index_max:'',temperature_2m_max:'°C',precipitation_sum:'mm',wind_gusts_10m_max:'km/h',precipitation_probability_max:'%'},daily:{uv_index_max:[6,6],time:['2026-10-11','2026-10-12'],temperature_2m_max:[24,24],precipitation_probability_max:[0,0],precipitation_sum:[0,0],wind_gusts_10m_max:[gust,gust],weather_code:[1,1]}});
const client={artifacts:{get:async()=>({id:'evidence'})}};
test('fresh check allows one exact-route send with forecast and prevents duplicate',async()=>{const t=trip();let calls=0;const c={...client,tools:{run:async request=>{calls++;assert.equal(request.args.to,'exact@g.us');assert.match(request.args.message,/24 °c/);return {ok:true,output:{json:{messageId:'receipt'}}}}}};const check=await checkRecommendation(t,input,now,c,async()=>forecast());assert.equal(check.status,'ready');const r=await sendRecommendation(t,{checkId:check.id,message:'plan'},now,c,async()=>{});assert.equal(r.status,'sent');await assert.rejects(()=>sendRecommendation(t,{checkId:check.id,message:'again'},now,c,async()=>{}));assert.equal(calls,1);});
test('failed weather, missing day, wrong units and strong gusts block sending',async()=>{for(const fetcher of [async()=>{throw Error('offline')},async()=>({...forecast(),daily:{...forecast().daily,time:['2026-10-11']}}),async()=>({...forecast(),daily_units:{}}),async()=>forecast(40)]){const t=trip();const c=await checkRecommendation(t,input,now,client,fetcher);assert.equal(c.status,'blocked');await assert.rejects(()=>sendRecommendation(t,{checkId:c.id,message:'plan'},now,client,async()=>{}));}});
test('expired or changed plan requires recheck',async()=>{for(const change of [false,true]){const t=trip();const c=await checkRecommendation(t,input,now,client,async()=>forecast());if(change)t.items.plan.title='changed';await assert.rejects(()=>sendRecommendation(t,{checkId:c.id,message:'plan'},change?now:now+7200000,client,async()=>{}));}});
test('uncertain sends persist and rechecking does not permit resending',async()=>{const t=trip();const client2={...client,tools:{run:async()=>{throw Error('timeout')}}};const c=await checkRecommendation(t,input,now,client2,async()=>forecast());const r=await sendRecommendation(t,{checkId:c.id,message:'plan'},now,client2,async()=>{});assert.equal(r.status,'uncertain');const c2=await checkRecommendation(t,input,now,client2,async()=>forecast());await assert.rejects(()=>sendRecommendation(t,{checkId:c2.id,message:'plan'},now,client2,async()=>{}));});
test('rain blocks outdoors while an indoor alternative still gets a forecast',async()=>{const f=forecast();f.daily.precipitation_probability_max=[80,80];f.daily.precipitation_sum=[6,6];assert.equal((await checkRecommendation(trip(),input,now,client,async()=>f)).status,'blocked');assert.equal((await checkRecommendation(trip(),{...input,exposure:'indoor'},now,client,async()=>f)).status,'ready');await assert.rejects(()=>checkRecommendation(trip(),{...input,timezone:undefined},now,client));});
test('new review prompts mandate gated proposal delivery',()=>{const text=noticePrompt({id:'trip'}, {id:'notice'});assert.match(text,/recommendation-check/);assert.match(text,/recommendation-send exclusively/);});
test('outdoor UV is requested, included and protection begins at 3',async()=>{
  for (const uv of [0,2.9,3,5.9,6,8,11]) {
    const t=trip(), f=forecast(); f.daily.uv_index_max=[uv,uv];
    const c=await checkRecommendation(t,input,now,client,async b=>{assert.match(weatherUrl(b),/uv_index_max/);return f;});
    assert.equal(c.status,'ready');
    await sendRecommendation(t,{checkId:c.id,message:'plan'},now,{...client,tools:{run:async r=>{
      assert.ok(r.args.message.includes(`índice uv máximo previsto: ${uv}`));
      assert.equal(r.args.message.includes('protector solar'),uv>=3);
      if(uv===6)assert.match(r.args.message,/\(alto\)/);
      return {ok:true,output:{json:{messageId:'receipt'}}};
    }}},async()=>{});
  }
});
test('missing or invalid UV blocks outdoor checks but not indoor checks',async()=>{
  for (const uv of [undefined,null,-1,NaN,Infinity,'6']) {
    const f=forecast(); f.daily.uv_index_max=[uv,uv];
    assert.equal((await checkRecommendation(trip(),input,now,client,async()=>f)).status,'blocked');
    assert.equal((await checkRecommendation(trip(),{...input,exposure:'indoor'},now,client,async()=>f)).status,'ready');
  }
  const f=forecast();f.daily_units.uv_index_max='W/m²';
  assert.equal((await checkRecommendation(trip(),input,now,client,async()=>f)).status,'blocked');
});
test('legacy ready outdoor checks without UV cannot send',async()=>{
  const t=trip(), c=await checkRecommendation(t,input,now,client,async()=>forecast());
  delete c.weather.values.uv_index_max;
  await assert.rejects(()=>sendRecommendation(t,{checkId:c.id,message:'plan'},now,client,async()=>{}),/UV/);
});
test('private items, missing artifacts and invalid dates fail closed',async()=>{const t=trip();t.items.plan.visibility='private';await assert.rejects(()=>checkRecommendation(t,input,now,client));await assert.rejects(()=>checkRecommendation(trip(),{...input,date:'2026-02-30'},now,client));await assert.rejects(()=>checkRecommendation(trip(),input,now,{artifacts:{get:async()=>null}}));});
