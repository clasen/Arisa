import crypto from 'node:crypto';
import { fetchWeather, analyzeWeather, weatherUrl, fingerprint } from './weather.js';

export const RECOMMENDATION_POLICY = 'For daily activity proposals, research one useful nonduplicate plan. Use recommendation-check with the exact place, local date, verified coordinates and a source artifact for logistical facts, then recommendation-send. Never send proposals directly through whatsapp-web. Missing or stale weather blocks sending, including indoor proposals; failed outdoor checks require research of an indoor alternative, not a conditional outdoor suggestion. Outdoor proposals must include a verified daily maximum UV index and sun protection advice from UV 3, explicitly identifying high UV from 6. Missing UV requires a new check, never an assumed low value. Opening hours, age restrictions and access must be researched when relevant. Do not substitute disclaimers for obtainable evidence. The gate verifies weather, not the truth of agent-supplied logistical facts.';
const localDay = (now, timezone) => new Intl.DateTimeFormat('en-CA', {timeZone:timezone, year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));

function binding(trip, data, now) {
  const item = trip.items[data.itemId];
  if (!item || item.visibility !== 'shared' || !['proposed','confirmed'].includes(item.status)) throw new Error('A shared proposed or confirmed item is required');
  if (!['outdoor','indoor'].includes(data.exposure)) throw new Error('exposure must be outdoor or indoor');
  if (typeof data.label !== 'string' || !data.label.trim() || data.label.length > 120) throw new Error('Place label required');
  for (const [key,max] of [['latitude',90],['longitude',180]]) if (!Number.isFinite(data[key]) || Math.abs(data[key])>max) throw new Error('Verified coordinates required');
  if (typeof data.timezone !== 'string' || !data.timezone.trim()) throw new Error('Explicit IANA timezone required');
  const today = localDay(now, data.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date) || !Number.isFinite(Date.parse(data.date)) || new Date(data.date).toISOString().slice(0,10)!==data.date || data.date < today || Date.parse(data.date)-Date.parse(today)>2*86400000) throw new Error('Date must be within the next three local calendar days');
  if (!data.logisticsArtifactId || !data.coordinatesArtifactId) throw new Error('Logistics and coordinate evidence artifacts required');
  return {itemId:item.id,label:data.label,latitude:data.latitude,longitude:data.longitude,timezone:data.timezone,from:data.date,to:data.date,requireUv:data.exposure==='outdoor'};
}

export async function checkRecommendation(trip, data, now, client, fetcher=fetchWeather) {
  if (!trip.active) throw new Error('Trip is paused');
  const b = binding(trip,data,now);
  for (const artifactId of new Set([data.logisticsArtifactId,data.coordinatesArtifactId])) {
    const a = await client.artifacts.get({artifactId});
    if (!a || a.ok === false) throw new Error('Evidence artifact not found');
  }
  const check = {id:crypto.randomUUID(),itemId:b.itemId,identity:fingerprint(trip.items[b.itemId]),place:b,exposure:data.exposure,date:data.date,checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+2*3600000).toISOString(),logisticsArtifactId:data.logisticsArtifactId,coordinatesArtifactId:data.coordinatesArtifactId,status:'blocked',reason:'weather-unverified'};
  try {
    const rows = analyzeWeather(b,await fetcher(b),now);
    const row = rows.find(r=>r.date===data.date);
    if (!row) throw new Error('Requested date not covered');
    const v=row.values;
    if(v.precipitation_probability_max<0 || v.precipitation_probability_max>100 || v.precipitation_sum<0 || v.wind_gusts_10m_max<0 || v.temperature_2m_max < -90 || v.temperature_2m_max > 60 || ![0,1,2,3,45,48,51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99].includes(v.weather_code)) throw new Error('Invalid forecast values');
    check.weather={provider:'Open-Meteo',sourceUrl:weatherUrl(b),observedAt:check.checkedAt,...row};
    const unsuitable=data.exposure==='outdoor' && (v.precipitation_probability_max>=50 || v.precipitation_sum>=2 || v.wind_gusts_10m_max>=35 || v.temperature_2m_max>=35 || [95,96,99].includes(v.weather_code));
    check.status=unsuitable?'blocked':'ready';
    check.reason=unsuitable?'outdoor-weather-policy':'forecast-checked';
  } catch { /* Fail closed; no send is permitted without a valid forecast. */ }
  trip.recommendationChecks ||= {};
  trip.recommendationChecks[check.id]=check;
  return check;
}

function sendable(trip, check, message, now) {
  if(!trip.active || trip.route.channel!=='whatsapp') throw new Error('Active WhatsApp trip required');
  if(!check || check.status!=='ready' || !check.weather || Date.parse(check.expiresAt)<=now || Date.parse(check.checkedAt)>now) throw new Error('Fresh successful recommendation-check required; uncertain sends must be reconciled');
  if(check.exposure==='outdoor' && (!check.place.requireUv || !Number.isFinite(check.weather.values?.uv_index_max) || check.weather.values.uv_index_max<0)) throw new Error('Verified UV forecast required; recheck legacy outdoor proposals');
  if(check.identity!==fingerprint(trip.items[check.itemId])) throw new Error('Plan changed; recheck required');
  if(check.date<localDay(now,check.place.timezone)) throw new Error('Proposal date has passed');
  if(typeof message!=='string' || !message.trim() || message.length>2000) throw new Error('Concise proposal text required');
  if(Object.values(trip.recommendationChecks).some(c=>c.id!==check.id && c.itemId===check.itemId && c.date===check.date && ['sending','sent','uncertain'].includes(c.status))) throw new Error('Existing send must be reconciled; do not repeat');
}
function uvSummary(value) {
  const level=value<3?'bajo':value<6?'moderado':value<8?'alto':value<11?'muy alto':'extremo';
  const protection=value>=3?' usen protector solar de amplio espectro fps 30 o más, reaplíquenlo cada 2 horas y después de mojarse o transpirar; sumen sombrero, ropa y sombra, especialmente para los chicos. eviten el sol del mediodía.':'';
  return ` índice uv máximo previsto: ${value} (${level}).${protection}`;
}
function weatherSummary(check) {
  const v=check.weather.values;
  return `pronóstico para ${check.place.label}, ${check.date}: máxima ${v.temperature_2m_max} °c, probabilidad de lluvia ${v.precipitation_probability_max}%, acumulado ${v.precipitation_sum} mm y ráfagas de hasta ${v.wind_gusts_10m_max} km/h. ${check.exposure==='indoor'?'propongo un plan bajo techo.':'con este pronóstico mantengo la propuesta exterior; no es una garantía de condiciones.'}${check.exposure==='outdoor'?uvSummary(v.uv_index_max):''}`;
}
export async function sendRecommendation(trip,args,now,client,checkpoint) {
  const check=trip.recommendationChecks?.[args.checkId];
  sendable(trip,check,args.message,now);
  check.message=`${args.message.trim()}\n\n${weatherSummary(check)}`;
  check.status='sending'; check.sendRequestedAt=new Date(now).toISOString();
  await checkpoint();
  try {
    const result=await client.tools.run({name:'whatsapp-web',args:{mode:'send',to:trip.route.destination,message:check.message}});
    const messageId=result?.ok && result.output?.json?.messageId;
    check.status=messageId?'sent':'uncertain';
    if(messageId) check.messageId=messageId;
  } catch { check.status='uncertain'; }
  await checkpoint();
  return {checkId:check.id,status:check.status,messageId:check.messageId??null};
}
