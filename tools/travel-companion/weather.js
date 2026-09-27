import crypto from 'node:crypto';
export const fingerprint = item => crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex');
const day = (now, timezone) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(now));
export function validBinding(trip, b) {
  const i = trip.items[b.itemId];
  return i?.visibility === 'shared' && i.status === 'confirmed' && fingerprint(i) === b.identity;
}
export function bindWeather(trip, data) {
  if (!Array.isArray(data) || !data.length || data.length > 30) throw new Error('Expected 1-30 weather locations');
  const bindings = data.map(b => {
    const i = trip.items[b.itemId];
    if (!i || i.visibility !== 'shared' || i.status !== 'confirmed') throw new Error('Weather requires a shared confirmed item');
    if (typeof b.label !== 'string' || !b.label.trim() || b.label.length > 120) throw new Error('Location label required');
    for (const [k,max] of [['latitude',90],['longitude',180]]) if (typeof b[k] !== 'number' || !Number.isFinite(b[k]) || Math.abs(b[k]) > max) throw new Error('Invalid coordinates');
    new Intl.DateTimeFormat('en', {timeZone:b.timezone}).format();
    for (const k of ['from','to']) if (!/^\d{4}-\d{2}-\d{2}$/.test(b[k]) || !Number.isFinite(Date.parse(b[k])) || new Date(b[k]).toISOString().slice(0,10) !== b[k]) throw new Error('Invalid local date');
    if (b.from > b.to || Date.parse(b.to)-Date.parse(b.from)>90*86400000) throw new Error('Invalid date range');
    if (i.startAt && day(Date.parse(i.startAt),b.timezone) !== b.from) throw new Error('Weather start date must match itinerary');
    if (i.endAt && day(Date.parse(i.endAt),b.timezone) !== b.to) throw new Error('Weather end date must match itinerary');
    return {itemId:b.itemId,label:b.label,latitude:b.latitude,longitude:b.longitude,timezone:b.timezone,from:b.from,to:b.to,identity:fingerprint(i)};
  });
  if (new Set(bindings.map(b=>b.itemId)).size !== bindings.length) throw new Error('Duplicate weather item');
  trip.weather = {enabled:true, bindings, checks:{}};
  return weatherView(trip);
}
export function weatherView(trip) {
  return {enabled:!!trip.weather?.enabled, provider:'Open-Meteo', locations:(trip.weather?.bindings || []).filter(b=>validBinding(trip,b)).map(b=>({...b,check:trip.weather.checks[b.itemId] || null})), invalidatedLocations:(trip.weather?.bindings || []).filter(b=>!validBinding(trip,b)).length};
}
export function weatherUrl(b) {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  for (const [k,v] of Object.entries({latitude:b.latitude,longitude:b.longitude,timezone:b.timezone,forecast_days:7,daily:'temperature_2m_max,precipitation_probability_max,precipitation_sum,wind_gusts_10m_max,weather_code',wind_speed_unit:'kmh',temperature_unit:'celsius',precipitation_unit:'mm'})) u.searchParams.set(k,v);
  return u.href;
}
export async function fetchWeather(b) {
  const url=weatherUrl(b);
  const r=await fetch(url,{signal:AbortSignal.timeout(12000),redirect:'error',headers:{'User-Agent':'ArisaTravelCompanion/0.3','Accept':'application/json'}});
  if (!r.ok) throw new Error(`Weather HTTP ${r.status}`);
  let text='';
  for await (const chunk of r.body) { text+=Buffer.from(chunk).toString('utf8'); if (text.length>250000) throw new Error('Weather response too large'); }
  return JSON.parse(text);
}
export function analyzeWeather(b, data, now) {
  const d=data.daily, units=data.daily_units;
  if (!d || !Array.isArray(d.time) || data.timezone !== b.timezone || units?.temperature_2m_max !== '°C' || units?.precipitation_sum !== 'mm' || units?.wind_gusts_10m_max !== 'km/h' || units?.precipitation_probability_max !== '%') throw new Error('Invalid weather schema or units');
  const today=day(now,b.timezone), horizon=new Date(Date.parse(today)+3*86400000).toISOString().slice(0,10);
  if (!d.time.includes(today)) throw new Error('Stale forecast coverage');
  const rows=[];
  for (let n=0;n<d.time.length;n++) {
    const date=d.time[n];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (n && date<=d.time[n-1])) throw new Error('Invalid forecast dates');
    if (date<b.from || date>b.to || date<today || date>=horizon) continue;
    const values={};
    for(const k of ['temperature_2m_max','precipitation_probability_max','precipitation_sum','wind_gusts_10m_max','weather_code']) {
      const v=d[k]?.[n]; if(typeof v!=='number' || !Number.isFinite(v)) throw new Error('Incomplete forecast'); values[k]=v;
    }
    const risks=[];
    if(values.temperature_2m_max>=35) risks.push('heat');
    if(values.precipitation_probability_max>=70 && values.precipitation_sum>=5) risks.push('rain');
    if(values.wind_gusts_10m_max>=50) risks.push('wind');
    if([95,96,99].includes(values.weather_code)) risks.push('thunderstorm');
    rows.push({date,values,risks});
  }
  return rows;
}
export async function checkWeather(trip, now, checkpoint, fetcher=fetchWeather) {
  if(!trip.active || !trip.watch?.enabled || !trip.weather?.enabled) return [];
  const results=[];
  for(const b of trip.weather.bindings) {
    if(results.length>=2) break;
    if(!validBinding(trip,b)) continue;
    const today=day(now,b.timezone);
    if(b.to<today || Date.parse(b.from)>Date.parse(today)+6*86400000) continue;
    const s=trip.weather.checks[b.itemId] ||= {};
    if(s.nextCheckAt && Date.parse(s.nextCheckAt)>now) continue;
    s.lastAttempt=new Date(now).toISOString(); s.nextCheckAt=new Date(now+12*3600000).toISOString();
    await checkpoint();
    try {
      const rows=analyzeWeather(b,await fetcher(b),now);
      s.lastResult={verified:true,observedAt:s.lastAttempt,sourceUrl:weatherUrl(b),rows};
      s.lastVerified=s.lastResult;
      // Supersede pending evidence, including when the risk disappears.
      s.pending=null;
      const fresh=rows.filter(r=>r.risks.some(risk=>!(s.notified || []).includes(`${r.date}:${risk}`)));
      if(fresh.length) s.pending={label:b.label,timezone:b.timezone,observedAt:s.lastAttempt,sourceUrl:weatherUrl(b),rows:fresh};
    } catch { s.lastResult={verified:false,reason:'verification-failed',observedAt:s.lastAttempt}; s.pending=null; }
    await checkpoint(); results.push({itemId:b.itemId,...s.lastResult});
  }
  return results;
}
export function pendingWeather(trip,now) {
  if(!trip.active || !trip.watch?.enabled || !trip.weather?.enabled) return [];
  const hour=Number(new Intl.DateTimeFormat('en',{timeZone:trip.timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date(now)));
  if(hour>=trip.quietStart || hour<trip.quietEnd) return [];
  return trip.weather.bindings.filter(b=>validBinding(trip,b) && trip.weather.checks[b.itemId]?.pending && now-Date.parse(trip.weather.checks[b.itemId].pending.observedAt)<18*3600000);
}
export function weatherClaimValid(trip,n,now) {
  const b=trip.weather?.bindings.find(b=>b.itemId===n.itemId);
  const s=trip.weather?.checks[n.itemId];
  return trip.weather?.enabled && trip.watch?.enabled && n.watchGeneration===trip.watch.generation && b && validBinding(trip,b) && b.identity===n.weatherIdentity && s?.lastResult?.verified && s.lastResult.observedAt===n.weatherEvidence.observedAt && now-Date.parse(n.weatherEvidence.observedAt)<18*3600000;
}
