import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import defaults from './config.js';
import { transact } from './store.js';
import * as d from './domain.js';
import { checkFlights, pendingAlerts, flightStateView } from './flights.js';

import { bindWeather, weatherView, checkWeather, pendingWeather } from './weather.js';
const NAME = 'travel-companion';
const help = `travel-companion v0.3.0
Usage:
  node index.js --help
  node index.js run --request-file <json>

All operations require request.chatId. Never infer a trip from its display name.
Use args.tripId and pass request.resourceId for group operations to enforce its exact binding.
Arguments are strings; data is a JSON object encoded as a string.

Actions:
  create: tripId, name, timezone (IANA), channel=whatsapp|telegram, destination
  list: summarize trips (scoped to request.resourceId when supplied)
  configure: tripId, timezone?, quietStart?, quietEnd? (notification timezone; itinerary zones remain per item)
  show: tripId; shared entries only. includePrivate=true requires no resourceId and ownerConfirmed=true.
  put: tripId, data={id,kind,title,status?,visibility?,startAt?,endAt?,startTimezone?,endTimezone?,address?,origin?,destination?,flightNumber?,airline?,notes?,amount?,currency?,paid?,sourceArtifactId?}
       Upserts a full item, replacing its previous content. No booking codes, PINs, passports or payment credentials.
       kind=flight|stay|car|plan|task|provision|place; status=proposed|confirmed|pending|done|cancelled.
       Read source documents first. Unknown payment status must omit paid. All timestamps require explicit offsets.
  put-many: tripId, data=[items]; atomic batch of up to 50 items with the same put schema.
  set-status: tripId, itemId, status (reminders are independent; cancel them separately)
  flight-observation: tripId, data={itemId,status,observedAt,sourceUrl}; manual evidence.
  flights-enable: tripId, confirm=true; enable automatic FlightStats checks on the existing watch (or start it).
  flights-disable: tripId; stop flight checks and block queued flight alerts.
  flights-status: tripId; show last attempts, verified evidence and next checks.
  flights-check: tripId; run due checks now (rate limits still apply).
  weather-enable: tripId, confirm=true, data=[{itemId,label,latitude,longitude,timezone,from,to}]; explicit local dates and verified coordinates. Replaces weather bindings.
  weather-disable: tripId; blocks queued weather alerts.
  weather-status: tripId; forecast evidence and invalidated bindings.
  weather-check: tripId; due checks only. 12-hour cadence, 7-day horizon, useful risks within 3 local calendar days. Not an official warning service.
  maps: address; returns an address-search link, not verified coordinates or travel time.
  remind: tripId, data={id,runAt,message}; schedules one guarded agent task for the bound channel.
  cancel-notice: tripId, noticeId; prevents later claims. A claimed/in-flight send cannot be recalled.
  watch: tripId, confirm=true; enables bounded proactive reviews via poll_tool. No automatic purchase or booking.
  pause: tripId; blocks new claims and stops the review poll. Does not recall an in-flight send.
  resume: tripId; enables claims again; use watch to restart proactive reviews.
  tick: tripId, generation (internal scheduled callback)
  claim: tripId, noticeId (internal notification delivery guard)
  finish: tripId, noticeId, token, outcome=sent|prepared|skipped|uncertain|failed, evidence?

WhatsApp destination must be an exact chat id. Telegram currently supports the owning chat only.
Participants are not independently authenticated by this tool: it trusts the owning Arisa session and explicit resource binding.
Flight monitoring uses the public FlightStats/Cirium page, without credentials or bypassing access restrictions.
Checks: >72h before departure daily; 72-24h every 6h; 24-6h every 2h; within 6h every 30min, until arrival +2h.
Exact local departure date, flight number and airport pair must match. Out-of-range/errors mean unverified, never unchanged.
Source typically publishes only +/-3 days. Earlier changes cannot be verified through this provider.
No continuous GPS, PDF extraction, automatic check-in or purchases are implemented.
Reminders need explicit approval/time. Reviews may suggest, research and ask questions without mention.
General reviews check every 5 minutes by default, wake at most once per unchanged local day, observe quiet hours 22-08,
and runs only near dated itinerary items. Claimed/uncertain notices are never retried automatically.
Scheduling errors remain outcome_uncertain for manual task reconciliation; do not repeat the mutation blindly.
`;

async function core(relative) {
  if (!process.env.ARISA_PACKAGE_DIR) throw new Error('ARISA_PACKAGE_DIR is required');
  return import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR, 'src', relative)).href);
}
function settings(config) {
  const result = {};
  for (const [name, [min, max]] of Object.entries({ POLL_SECONDS: [60,3600], REVIEW_INTERVAL_HOURS: [1,168], REVIEW_HORIZON_DAYS: [1,90], MAX_REMINDER_LATENESS_MINUTES: [1,1440] })) {
    const n = Number(config[name]);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
    result[name] = n;
  }
  return result;
}
async function enqueueNotice(trip, notice, client, checkpoint) {
  notice.status = 'preparing';
  await checkpoint();
  try {
    const task = await client.tasks.add({ task: {
      kind: 'agent_task', runAt: notice.runAt, payload: { prompt: d.noticePrompt(trip, notice) },
      source: { resourceId: trip.route.destination }, retry: { maxAttempts: 1 }
    } });
    notice.taskId = task.id;
    notice.status = 'scheduled';
  } catch (error) {
    notice.status = 'uncertain';
    notice.error = 'Scheduling outcome uncertain; inspect tasks before retrying.';
  }
  await checkpoint();
  return { id: notice.id, runAt: notice.runAt, status: notice.status, taskId: notice.taskId, error: notice.error };
}
async function startWatch(trip, args, client, config, checkpoint, now) {
  if (args.confirm !== 'true') throw new Error('watch requires confirm=true');
  if (!trip.active) throw new Error('Resume the trip before enabling watch');
  if (trip.watch?.enabled || ['preparing','uncertain'].includes(trip.watch?.status)) return trip.watch;
  trip.watch = { enabled: true, generation: crypto.randomUUID(), status: 'preparing', taskId: null };
  await checkpoint();
  try {
    const task = await client.tasks.add({ task: {
      kind: 'poll_tool', runAt: new Date(now + config.POLL_SECONDS * 1000).toISOString(),
      payload: { toolName: NAME, args: { action: 'tick', tripId: trip.id, generation: trip.watch.generation } },
      recurrence: { type: 'interval', everySeconds: config.POLL_SECONDS }, source: { resourceId: trip.route.destination }
    } });
    trip.watch.taskId = task.id; trip.watch.status = 'scheduled';
  } catch { trip.watch.enabled = false; trip.watch.status = 'uncertain'; }
  await checkpoint();
  return trip.watch;
}
async function flightTick(trip, client, checkpoint, now) {
  const checks = await checkFlights(trip, now, checkpoint);
  const alerts = [];
  if (!trip.active || !trip.flightMonitoring?.enabled || !trip.watch?.enabled) return { checks, alerts };
  for (const [itemId, state] of pendingAlerts(trip, now)) {
    const notice = { id: `flight-${crypto.randomUUID()}`, kind: 'flight', itemId,
      flightIdentity: state.identity, watchGeneration: trip.watch.generation,
      flightEvidence: state.pending, runAt: new Date(now).toISOString(), status: 'preparing', taskId: null };
    if (state.pending.type === 'unavailable') state.unavailableNotified = true;
    delete state.pending;
    trip.notices[notice.id] = notice;
    alerts.push(await enqueueNotice(trip, notice, client, checkpoint));
  }
  return { checks, alerts };
}
async function weatherTick(trip, client, checkpoint, now) {
  const checks = await checkWeather(trip, now, checkpoint);
  const alerts = [];
  for (const b of pendingWeather(trip, now)) {
    const s = trip.weather.checks[b.itemId];
    const evidence = s.pending;
    const notice = { id: `weather-${crypto.randomUUID()}`, kind: 'weather', itemId: b.itemId, weatherIdentity: b.identity,
      watchGeneration: trip.watch.generation, weatherEvidence: evidence, runAt: new Date(now).toISOString(), status: 'preparing', taskId: null };
    s.notified = [...new Set([...(s.notified || []), ...evidence.rows.flatMap(r => r.risks.map(risk => `${r.date}:${risk}`))])];
    s.pending = null;
    trip.notices[notice.id] = notice;
    alerts.push(await enqueueNotice(trip, notice, client, checkpoint));
  }
  return { checks, alerts };
}
async function tick(trip, args, client, config, checkpoint, now) {
  if (args.generation !== trip.watch?.generation || !trip.active || !trip.watch?.enabled) return { status: 'no-change' };
  const flightResult = await flightTick(trip, client, checkpoint, now);
  const weatherResult = await weatherTick(trip, client, checkpoint, now);
  if (flightResult.alerts.length || weatherResult.alerts.length) return { status: 'alerts', flights: flightResult, weather: weatherResult };
  if (!d.reviewDue(trip, now, config)) return { status: 'no-change', ...flightResult };
  const fingerprint = d.reviewFingerprint(trip, now);
  if (fingerprint === trip.lastReviewFingerprint) return { status: 'no-change' };
  const notice = { id: `review-${crypto.randomUUID()}`, kind: 'review', runAt: new Date(now).toISOString(), status: 'preparing', taskId: null };
  trip.lastReviewAt = notice.runAt; trip.lastReviewFingerprint = fingerprint;
  trip.notices[notice.id] = notice;
  return enqueueNotice(trip, notice, client, checkpoint);
}
export async function action(request, state, checkpoint, client, config) {
  const a = request.args || {}; const now = Date.now();
  if (a.action === 'maps') return { url: d.mapsLink(a.address), precision: 'address-search' };
  if (a.action === 'list') return Object.values(state.trips).filter(t => !request.resourceId || t.route.destination === request.resourceId).map(t => ({ id:t.id,name:t.name,active:t.active,route:t.route }));
  if (a.action === 'create') {
    if (request.resourceId && request.resourceId !== a.destination) throw new Error('Resource binding mismatch');
    return d.view(d.createTrip(state, a, request.chatId));
  }
  const trip = d.getTrip(state, a.tripId, request.resourceId);
  switch (a.action) {
    case 'configure': {
      if (a.timezone) trip.timezone = d.zone(a.timezone);
      const start = a.quietStart == null ? trip.quietStart : Number(a.quietStart);
      const end = a.quietEnd == null ? trip.quietEnd : Number(a.quietEnd);
      if (!Number.isInteger(start) || !Number.isInteger(end) || end < 0 || start > 23 || start <= end) throw new Error('Quiet hours must span midnight: 0 <= quietEnd < quietStart <= 23');
      trip.quietStart = start; trip.quietEnd = end;
      return { timezone: trip.timezone, quietStart: start, quietEnd: end };
    }
    case 'show':
      if (a.includePrivate === 'true' && (request.resourceId || a.ownerConfirmed !== 'true')) throw new Error('Private view requires explicit owner confirmation outside a group resource');
      return d.view(trip, a.includePrivate === 'true');
    case 'put': {
      const data = d.object(a.data);
      if (request.resourceId && (data.visibility === 'private' || trip.items[data.id]?.visibility === 'private')) throw new Error('Private items require an owner-only invocation');
      if (data.sourceArtifactId) {
        const artifact = await client.artifacts.get({ artifactId: data.sourceArtifactId });
        if (!artifact || artifact.ok === false) throw new Error('Source artifact not found');
      }
      return d.putItem(trip, data);
    }
    case 'put-many': {
      const entries = typeof a.data === 'string' ? JSON.parse(a.data) : a.data;
      if (!Array.isArray(entries) || !entries.length || entries.length > 50) throw new Error('data must contain 1 to 50 items');
      for (const item of entries) {
        d.normalizeItem(item);
        if (request.resourceId && (item.visibility === 'private' || trip.items[item.id]?.visibility === 'private')) throw new Error('Private items require an owner-only invocation');
        if (item.sourceArtifactId) {
          const artifact = await client.artifacts.get({ artifactId: item.sourceArtifactId });
          if (!artifact || artifact.ok === false) throw new Error('Source artifact not found');
        }
      }
      return entries.map(item => { const result = d.putItem(trip, item); return { id: result.id, title: result.title }; });
    }
    case 'set-status': {
      const item = trip.items[d.key(a.itemId)];
      if (!item || (request.resourceId && item.visibility === 'private')) throw new Error('Item not found');
      return d.putItem(trip, { ...item, status: a.status });
    }
    case 'weather-status': return weatherView(trip);
    case 'weather-enable': {
      if (a.confirm !== 'true' || !trip.active) throw new Error('Active trip and confirm=true required');
      const result = bindWeather(trip, typeof a.data === 'string' ? JSON.parse(a.data) : a.data);
      await startWatch(trip, { confirm: 'true' }, client, config, checkpoint, now);
      return result;
    }
    case 'weather-disable':
      if (trip.weather) trip.weather.enabled = false;
      for (const n of Object.values(trip.notices)) if (n.kind === 'weather' && ['scheduled','queued','preparing'].includes(n.status)) n.status = 'cancelled';
      return { enabled: false };
    case 'weather-check': return weatherTick(trip, client, checkpoint, now);
    case 'flights-status': return flightStateView(trip);
    case 'flights-enable': {
      if (a.confirm !== 'true') throw new Error('flights-enable requires confirm=true');
      if (!trip.active) throw new Error('Resume the trip first');
      trip.flightMonitoring = { enabled: true };
      await startWatch(trip, { confirm: 'true' }, client, config, checkpoint, now);
      return { ...flightStateView(trip), watch: trip.watch };
    }
    case 'flights-disable':
      trip.flightMonitoring = { enabled: false };
      for (const state of Object.values(trip.flightChecks || {})) delete state.pending;
      for (const n of Object.values(trip.notices)) if (n.kind === 'flight' && ['scheduled','queued','preparing'].includes(n.status)) n.status = 'cancelled';
      return { enabled: false };
    case 'flights-check': return flightTick(trip, client, checkpoint, now);
    case 'flight-observation': {
      const data = d.object(a.data);
      if (request.resourceId && trip.items[data.itemId]?.visibility === 'private') throw new Error('Item not found');
      return d.observeFlight(trip, data, now);
    }
    case 'remind':
      if (!trip.active) throw new Error('Trip is paused');
      return enqueueNotice(trip, d.addNotice(trip, d.object(a.data), now), client, checkpoint);
    case 'watch': return startWatch(trip, a, client, config, checkpoint, now);
    case 'tick': return tick(trip, a, client, config, checkpoint, now);
    case 'claim': return d.claimNotice(trip, a.noticeId, now, config);
    case 'finish': return d.finishNotice(trip, a);
    case 'pause':
      trip.active = false;
      if (trip.watch) trip.watch.enabled = false;
      await checkpoint();
      if (trip.watch?.taskId) await client.tasks.cancel({ id: trip.watch.taskId });
      if (trip.watch) trip.watch.status = 'stopped';
      return { active: false };
    case 'resume': trip.active = true; return { active: true };
    case 'cancel-notice': {
      const n = trip.notices[d.key(a.noticeId)];
      if (!n) throw new Error('Notice not found');
      if (['claimed','sent','prepared','uncertain'].includes(n.status)) throw new Error('Already claimed, sent or uncertain. Reconcile before taking further action.');
      n.status = 'cancelled'; await checkpoint();
      if (n.taskId) await client.tasks.cancel({ id: n.taskId });
      return { id: n.id, status: n.status };
    }
    default: throw new Error('Unknown action; inspect --help');
  }
}
async function run(file) {
  const request = JSON.parse(await readFile(file, 'utf8'));
  if (!request.chatId) throw new Error('chatId is required');
  const { loadToolConfig } = await core('core/tools/tool-config.js');
  const { getChatToolStateDir } = await core('runtime/paths.js');
  const { createArisaClient } = await core('core/tools/ipc-client.js');
  const { toolOk } = await core('core/tools/tool-result.js');
  const config = settings(await loadToolConfig(NAME, defaults, request.chatId));
  const client = createArisaClient({ toolName: NAME, chatId: request.chatId });
  const result = await transact(getChatToolStateDir(request.chatId, NAME), async (state, checkpoint) => {
    const out = await action(request, state, checkpoint, client, config);
    await checkpoint();
    return out;
  });
  console.log(JSON.stringify(toolOk({ text: JSON.stringify(result, null, 2), json: result })));
}
const argv = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
if (!argv.length || argv.includes('--help')) console.log(help);
else if (argv[0] === 'run' && argv.includes('--request-file')) {
  try { await run(argv[argv.indexOf('--request-file') + 1]); }
  catch (error) { console.log(JSON.stringify({ ok: false, status: 'error', error: error.message })); }
} else { console.error(help); process.exitCode = 1; }
}
