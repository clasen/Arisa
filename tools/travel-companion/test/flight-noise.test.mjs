import test from 'node:test';
import assert from 'node:assert/strict';
import {checkFlights, changes} from '../flights.js';

const item = {id:'f',kind:'flight',visibility:'shared',status:'confirmed',flightNumber:'IB103',origin:'MAD',destination:'EZE',startTimezone:'Europe/Madrid',startAt:'2026-10-13T22:05:00.000Z',endAt:'2026-10-14T10:40:00.000Z'};
const base = {verified:true,scheduledDeparture:item.startAt,scheduledArrival:item.endAt,status:'A',description:'On time',arrivalTimeType:'Estimated'};
const arrival = (time, type='Estimated') => ({...base, estimatedArrival:`2026-10-14T${time}:00.000Z`,arrivalTimeType:type});

test('real IB103 estimate oscillations remain silent; actual arrival emits once', async()=>{
  const t={active:true,watch:{enabled:true},flightMonitoring:{enabled:true},items:{f:item}};
  let now=Date.parse('2026-10-13T22:00:00Z');
  for (const time of ['10:40','10:01','10:22','10:47','10:20']) {
    await checkFlights(t,now,async()=>{},async()=>arrival(time));
    assert.equal(t.flightChecks.f.pending,undefined);
    now+=1800000;
  }
  await checkFlights(t,now,async()=>{},async()=>arrival('10:32','Actual'));
  assert.equal(t.flightChecks.f.pending.changes[0].afterTimeType,'Actual');
  delete t.flightChecks.f.pending;
  await checkFlights(t,now+1800000,async()=>{},async()=>arrival('10:32','Actual'));
  assert.equal(t.flightChecks.f.pending,undefined);
});
test('arrival type transition is useful even with identical timestamp',()=>{
  assert.equal(changes(item,arrival('10:32'),arrival('10:32','Actual'))[0].afterTimeType,'Actual');
});
test('material delay and recovery remain actionable',()=>{
  assert.ok(changes(item,arrival('10:40'),arrival('11:15')).length);
  assert.equal(changes(item,arrival('11:15'),arrival('11:25')).length,0);
  assert.ok(changes(item,arrival('11:15'),arrival('11:45')).length);
  assert.ok(changes(item,arrival('11:15'),arrival('10:50')).length);
});
test('terminal changes are actionable without airport-specific exceptions',()=>{
  const before={...base,departureTerminal:'4',departureGate:'S41'};
  assert.ok(changes(item,before,{...before,departureTerminal:'4S'}).length);
  assert.ok(changes(item,{...before,departureTerminal:'4S'},before).length);
  assert.ok(changes(item,before,{...before,departureGate:'S42'}).length);
  assert.ok(changes(item,before,{...before,departureTerminal:'1'}).length);
  assert.ok(changes({...item,origin:'OTHER'},before,{...before,departureTerminal:'4S'}).length);
});
test('cancellations, diversions and scheduled changes remain actionable',()=>{
  for (const patch of [{status:'C',description:'Cancelled'},{status:'D',description:'Diverted'},{scheduledArrival:'2026-10-14T11:40:00.000Z'}]) {
    assert.ok(changes(item,base,{...base,...patch}).length);
  }
});
