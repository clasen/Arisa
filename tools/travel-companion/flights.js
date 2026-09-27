import crypto from 'node:crypto';
const HOUR = 3600000;
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function flightQuery(item) {
  const match = /^([A-Z0-9]{2})\s*(\d{1,4})$/.exec(item.flightNumber || '');
  if (!match || !item.startAt || !item.startTimezone || !/^[A-Z]{3}$/.test(item.origin || '') || !/^[A-Z]{3}$/.test(item.destination || '')) throw Error('Flight needs IATA flight number, airports, departure time and timezone');
  const parts = new Intl.DateTimeFormat('en', {timeZone:item.startTimezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(item.startAt));
  const p = Object.fromEntries(parts.map(x => [x.type,x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { carrier:match[1], number:String(Number(match[2])), date, origin:item.origin, destination:item.destination,
    url:`https://www.flightstats.com/v2/flight-tracker/${match[1]}/${Number(match[2])}?year=${p.year}&month=${p.month}&date=${p.day}` };
}
export const flightIdentity = item => hash([item.flightNumber,item.startAt,item.endAt,item.startTimezone,item.origin,item.destination,item.visibility,item.status]);
export function cadence(item, now) {
  const remaining = Date.parse(item.startAt)-now;
  const end = Date.parse(item.endAt || item.startAt);
  if (!Number.isFinite(remaining) || now > end + 2*HOUR) return null;
  return remaining > 72*HOUR ? 24*HOUR : remaining > 24*HOUR ? 6*HOUR : remaining > 6*HOUR ? 2*HOUR : HOUR/2;
}
function embeddedData(html) {
  const script = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (script) return JSON.parse(script[1]);
  const assignment = html.match(/(?:window\.)?__NEXT_DATA__\s*=\s*(\{[\s\S]*?\});\s*(?:__NEXT_|<\/script>)/);
  if (!assignment) throw Error('Provider schema unavailable');
  return JSON.parse(assignment[1]);
}
function utc(value) {
  if (typeof value !== 'string' || !/Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw Error('Invalid provider UTC timestamp');
  return new Date(value).toISOString();
}
export function parseFlight(html, query) {
  const root = embeddedData(html);
  if(root.props?.initialProps?.pageProps?.isOutOfDateRange) return {verified:false,reason:'date-out-of-range'};
  const f=root.props?.initialState?.flightTracker?.flight;
  if(!f?.schedule) return {verified:false,reason:'no-dated-flight-data'};
  const header=f.resultHeader;
  if(header?.carrier?.fs !== query.carrier || String(Number(header.flightNumber)) !== query.number || f.schedule.scheduledDeparture?.slice(0,10)!==query.date || f.departureAirport?.fs!==query.origin || f.arrivalAirport?.fs!==query.destination) return {verified:false,reason:'flight-identity-mismatch'};
  if(!f.status?.statusCode) return {verified:false,reason:'missing-status'};
  const scheduledDeparture=utc(f.schedule.scheduledDepartureUTC), scheduledArrival=utc(f.schedule.scheduledArrivalUTC);
  if(scheduledArrival<=scheduledDeparture) throw Error('Invalid provider flight chronology');
  return {verified:true, scheduledDeparture,scheduledArrival,
    estimatedDeparture:f.schedule.estimatedActualDepartureUTC ? utc(f.schedule.estimatedActualDepartureUTC) : null,
    estimatedArrival:f.schedule.estimatedActualArrivalUTC ? utc(f.schedule.estimatedActualArrivalUTC) : null,
    departureTimeType:String(f.schedule.estimatedActualDepartureTitle || '').slice(0,40),arrivalTimeType:String(f.schedule.estimatedActualArrivalTitle || '').slice(0,40),
    status:String(f.status.statusCode).slice(0,20),description:String(f.status.statusDescription || '').slice(0,150),
    departureTerminal:f.departureAirport.terminal ? String(f.departureAirport.terminal).slice(0,40):null,
    arrivalTerminal:f.arrivalAirport.terminal ? String(f.arrivalAirport.terminal).slice(0,40):null,
    departureGate:f.departureAirport.gate ? String(f.departureAirport.gate).slice(0,40):null,
    arrivalGate:f.arrivalAirport.gate ? String(f.arrivalAirport.gate).slice(0,40):null,
    providerUpdatedText:String(f.status.lastUpdatedText || '').slice(0,150), provider:'FlightStats / Cirium (public third-party source)'};
}
export async function fetchFlight(query) {
  const response=await fetch(query.url,{redirect:'error',signal:AbortSignal.timeout(12000),headers:{'User-Agent':'ArisaTravelCompanion/0.2 (flight status research)','Cache-Control':'no-cache'}});
  if(!response.ok) throw Error(`Provider HTTP ${response.status}`);
  let size=0;const chunks=[];
  for await(const chunk of response.body) {size+=chunk.length;if(size>2000000)throw Error('Provider response too large');chunks.push(chunk);}
  return parseFlight(Buffer.concat(chunks).toString('utf8'),query);
}
export function changes(item, before, current) {
  const diff=[];
  const baseline=before || {scheduledDeparture:item.startAt,scheduledArrival:item.endAt};
  for(const field of ['scheduledDeparture','scheduledArrival','departureTerminal','arrivalTerminal','departureGate','arrivalGate']) {
    if(current[field] && (baseline[field] || (before && /Terminal|Gate/.test(field))) && baseline[field]!==current[field])diff.push({field,before:baseline[field],after:current[field]});
  }
  for(const [field,scheduled] of [['estimatedDeparture','scheduledDeparture'],['estimatedArrival','scheduledArrival']]) {
    const old=baseline[field] || baseline[scheduled];
    if(current[field] && old && Math.abs(Date.parse(current[field])-Date.parse(old))>=10*60000)diff.push({field,before:old,after:current[field]});
  }
  const abnormal = x => ['C','D','DN','NO','U'].includes(x?.status) || /cancel|divert|delay/i.test(x?.description || '');
  if((abnormal(current)||abnormal(before)) && (current.status!==before?.status || abnormal(current)!==abnormal(before)))diff.push({field:'status',before:before?.status || 'document-only',after:current.status,description:current.description});
  return diff;
}
export function eligible(item) { return item.kind==='flight' && item.visibility==='shared' && item.status==='confirmed'; }
export function flightStateView(trip) {
 return {enabled:!!trip.flightMonitoring?.enabled, provider:'FlightStats / Cirium', flights:Object.entries(trip.flightChecks || {}).filter(([id])=>eligible(trip.items[id] || {})).map(([id,s])=>({itemId:id,lastAttempt:s.lastAttempt,nextCheckAt:s.nextCheckAt,lastResult:s.lastResult,lastVerified:s.lastVerified,pendingAlert:!!s.pending,failures:s.failures}))};
}
export async function checkFlights(trip,now,checkpoint,fetcher=fetchFlight) {
 if(!trip.active || !trip.flightMonitoring?.enabled || !trip.watch?.enabled) return [];
 trip.flightChecks ||= {};
 const results=[];
 for(const item of Object.values(trip.items).filter(eligible)) {
   if(results.length>=2)break;
   const previous = trip.flightChecks[item.id];
   const identity=flightIdentity(item);
   const observedEnd = previous?.identity === identity ? previous.lastVerified?.estimatedArrival || previous.lastVerified?.scheduledArrival : null;
   const effectiveEnd = observedEnd && Date.parse(observedEnd) > Date.parse(item.endAt || item.startAt) ? observedEnd : item.endAt;
   const interval=cadence({...item,endAt:effectiveEnd},now);if(interval===null)continue;
   let s=trip.flightChecks[item.id];
   if(!s || s.identity!==identity) s=trip.flightChecks[item.id]={identity,failures:0};
   if(s.lastAttempt && now-Date.parse(s.lastAttempt)<interval)continue;
   // Checkpoint before network: a crashed poll waits for the next bounded slot.
   s.lastAttempt=new Date(now).toISOString();s.nextCheckAt=new Date(now+interval).toISOString();
   await checkpoint();
   let result,query;
   try {query=flightQuery(item);result=await fetcher(query);}catch(e){result={verified:false,reason:String(e.message).slice(0,160)};}
   result={...result,sourceUrl:query?.url || null,observedAt:new Date(now).toISOString(),flightNumber:item.flightNumber,departureDate:query?.date};
   s.lastResult=result;
   if(result.verified) {
     const diff=changes(item,s.comparisonBaseline || s.lastVerified,result);
     s.failures=0;
     // Preserve a comparison anchor so small successive delays accumulate.
     if(!s.comparisonBaseline || diff.length) s.comparisonBaseline=result;
     s.lastVerified=result;
     if(diff.length) s.pending={type:'change',changes:diff,evidence:result};
     else if(s.pending?.type==='unavailable')delete s.pending;
   } else {
     s.failures++;
     if(Date.parse(item.startAt)-now<=72*HOUR && s.failures>=2 && !s.unavailableNotified && !s.pending) s.pending={type:'unavailable',evidence:result};
   }
   results.push({itemId:item.id,...result});await checkpoint();
 }
 return results;
}
export function pendingAlerts(trip,now) {
 const hour=Number(new Intl.DateTimeFormat('en',{timeZone:trip.timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date(now)));
 const quiet=hour>=trip.quietStart || hour<trip.quietEnd;
 return Object.entries(trip.flightChecks || {}).filter(([id,s])=>{
   const item=trip.items[id];
   return eligible(item || {}) && s.identity===flightIdentity(item) && s.pending && (!quiet || Date.parse(item.startAt)-now<=24*HOUR);
 });
}
