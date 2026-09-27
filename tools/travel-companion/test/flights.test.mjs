import test from 'node:test';
import assert from 'node:assert/strict';
import {flightQuery,flightIdentity,parseFlight,cadence,changes,checkFlights,pendingAlerts} from '../flights.js';
import {claimNotice} from '../domain.js';
const item={id:'f',kind:'flight',visibility:'shared',status:'confirmed',flightNumber:'IB108',origin:'EZE',destination:'MAD',startTimezone:'America/Argentina/Buenos_Aires',startAt:'2026-10-01T00:45:00.000Z',endAt:'2026-10-01T12:35:00.000Z'};
const now=Date.parse('2026-09-30T12:00:00Z'),H=3600000;
const query=flightQuery(item);
function fixture(patch={}) {
 const flight={schedule:{scheduledDeparture:'2026-09-30T21:45:00.000',scheduledDepartureUTC:item.startAt,scheduledArrivalUTC:item.endAt},status:{statusCode:'S',statusDescription:'On time'},resultHeader:{carrier:{fs:'IB'},flightNumber:'108'},departureAirport:{fs:'EZE',terminal:'P'},arrivalAirport:{fs:'MAD',terminal:'4S'},...patch};
 const data={props:{initialState:{flightTracker:{flight}},initialProps:{pageProps:{isOutOfDateRange:false}}}};
 return `__NEXT_DATA__ = ${JSON.stringify(data)};__NEXT_LOADED_PAGES__=[];`;
}
const good=()=>parseFlight(fixture(),query);
function trip(){return {active:true,timezone:'UTC',quietStart:22,quietEnd:8,watch:{enabled:true,generation:'g'},flightMonitoring:{enabled:true},items:{f:{...item}},notices:{}};}
test('query uses origin local date, not UTC arrival day',()=>{assert.equal(query.date,'2026-09-30');assert.match(query.url,/month=09&date=30/);assert.throws(()=>flightQuery({...item,startTimezone:null}));});
test('parser confirms exact identity and UTC fields',()=>{assert.equal(good().verified,true);assert.equal(good().scheduledArrival,item.endAt);});
test('different flight number/date/route rejected, no other-day fallback',()=>{
 assert.equal(parseFlight(fixture(),{...query,date:'2026-10-01'}).verified,false);
 assert.equal(parseFlight(fixture(),{...query,number:'103'}).verified,false);
 assert.equal(parseFlight(fixture(),{...query,origin:'MAD'}).verified,false);
});
test('date out of range beats any other embedded flight',()=>assert.equal(parseFlight(fixture().replace('"isOutOfDateRange":false','"isOutOfDateRange":true'),query).reason,'date-out-of-range'));
test('malformed pages and anti-bot pages fail closed',()=>{assert.throws(()=>parseFlight('<html>Access denied</html>',query));assert.throws(()=>parseFlight(fixture({schedule:{scheduledDeparture:'2026-09-30',scheduledDepartureUTC:'bad'}}),query));});
test('cadence tightens and stops after arrival',()=>{
 const dep=Date.parse(item.startAt);assert.equal(cadence(item,dep-100*H),24*H);assert.equal(cadence(item,dep-48*H),6*H);assert.equal(cadence(item,dep-12*H),2*H);assert.equal(cadence(item,dep-3*H),H/2);assert.equal(cadence(item,Date.parse(item.endAt)+3*H),null);
});
test('first matching observation silent; changes in time and cancellation detected',()=>{
 assert.equal(changes(item,null,good()).length,0);
 assert.equal(changes(item,null,{...good(),scheduledDeparture:'2026-10-01T01:45:00.000Z'})[0].field,'scheduledDeparture');
 assert.ok(changes(item,good(),{...good(),status:'C',description:'Cancelled'}).some(x=>x.field==='status'));
});
test('terminal/gate updates and delay recovery detected',()=>{
 assert.ok(changes(item,good(),{...good(),arrivalTerminal:'4',departureGate:'12'}).some(x=>x.field==='arrivalTerminal'));
 const late={...good(),estimatedArrival:'2026-10-01T13:35:00Z'};
 assert.ok(changes(item,late,{...good(),estimatedArrival:item.endAt}).some(x=>x.field==='estimatedArrival'));
});
test('due checks persist before networking, dedupe and preserve last verified on failure',async()=>{
 const t=trip();let saved=0,calls=0;const fetcher=async()=>{assert.ok(saved);calls++;return good();};
 await checkFlights(t,now,async()=>{saved++;},fetcher);await checkFlights(t,now+60000,async()=>{},fetcher);assert.equal(calls,1);assert.equal(t.flightChecks.f.pending,undefined);
 await checkFlights(t,now+2*H,async()=>{},async()=>{throw Error('network timeout');});assert.equal(t.flightChecks.f.lastResult.verified,false);assert.equal(t.flightChecks.f.lastVerified.verified,true);
});
test('repeated outages notify once near departure, never claim unchanged',async()=>{
 const t=trip(),fail=async()=>({verified:false,reason:'date-out-of-range'});
 await checkFlights(t,now,async()=>{},fail);assert.equal(t.flightChecks.f.pending,undefined);
 await checkFlights(t,now+2*H,async()=>{},fail);assert.equal(t.flightChecks.f.pending.type,'unavailable');
 t.flightChecks.f.unavailableNotified=true;delete t.flightChecks.f.pending;
 await checkFlights(t,now+4*H,async()=>{},fail);assert.equal(t.flightChecks.f.pending,undefined);
});
test('private/cancelled flights and paused trips not fetched',async()=>{
 for(const mutate of [t=>t.items.f.visibility='private',t=>t.items.f.status='cancelled',t=>t.active=false,t=>t.watch.enabled=false,t=>t.flightMonitoring.enabled=false]) {
  const t=trip();mutate(t);let called=false;await checkFlights(t,now,async()=>{},async()=>{called=true;return good();});assert.equal(called,false);
 }
});
test('itinerary edits invalidate prior state and force fresh exact-date check',async()=>{
 const t=trip();await checkFlights(t,now,async()=>{},async()=>good());t.items.f.startAt='2026-10-02T00:45:00Z';
 let date;await checkFlights(t,now+1000,async()=>{},async q=>{date=q.date;return {verified:false,reason:'unavailable'};});assert.equal(date,'2026-10-01');assert.equal(t.flightChecks.f.lastVerified,undefined);
});
test('change checks queue evidence and repeated matching result does not repeat',async()=>{
 const t=trip();await checkFlights(t,now,async()=>{},async()=>good());
 const later={...good(),scheduledArrival:'2026-10-01T13:35:00Z'};await checkFlights(t,now+2*H,async()=>{},async()=>later);
 assert.equal(pendingAlerts(t,now+2*H).length,1);delete t.flightChecks.f.pending;
 await checkFlights(t,now+4*H,async()=>{},async()=>later);assert.equal(t.flightChecks.f.pending,undefined);
});
test('small delay drift accumulates to threshold',async()=>{
 const t=trip();await checkFlights(t,now,async()=>{},async()=>good());
 await checkFlights(t,now+2*H,async()=>{},async()=>({...good(),estimatedArrival:'2026-10-01T12:41:00Z'}));assert.equal(t.flightChecks.f.pending,undefined);
 await checkFlights(t,now+4*H,async()=>{},async()=>({...good(),estimatedArrival:'2026-10-01T12:47:00Z'}));assert.equal(t.flightChecks.f.pending.type,'change');
});
test('old flight alert cannot claim after identity changes or disable',()=>{
 for(const mutate of [t=>t.items.f.visibility='private',t=>t.items.f.startAt='2026-10-02T00:45:00Z',t=>t.flightMonitoring.enabled=false]) {
 const t=trip();t.notices.n={id:'n',kind:'flight',itemId:'f',flightIdentity:flightIdentity(item),watchGeneration:'g',runAt:new Date(now).toISOString(),status:'scheduled'};mutate(t);
 assert.equal(claimNotice(t,'n',now,{}).permitted,false);
 }
});
