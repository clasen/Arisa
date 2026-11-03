import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function recordPath(root, id) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id || '')) throw new Error('Invalid appointmentId');
  return path.join(root, 'appointments', `${id}.json`);
}
export async function getAppointment(root, id) {
  return JSON.parse(await readFile(recordPath(root, id), 'utf8'));
}
function validate(data) {
  if (!data || !['whatsapp', 'telegram'].includes(data.channel)) throw new Error('Explicit channel required');
  for (const key of ['destination', 'title', 'startAt', 'timezone']) {
    if (typeof data[key] !== 'string' || !data[key].trim() || data[key].length > 500) throw new Error(`Invalid ${key}`);
  }
  if (!/(Z|[+-]\d\d:\d\d)$/.test(data.startAt) || !Number.isFinite(Date.parse(data.startAt))) throw new Error('startAt requires an offset');
  new Intl.DateTimeFormat('en', { timeZone: data.timezone });
  if (data.address !== undefined && (typeof data.address !== 'string' || data.address.length > 500)) throw new Error('Invalid address');
  if (!['confirmed', 'cancelled'].includes(data.status)) throw new Error('Invalid status');
  return Object.fromEntries(['channel','destination','title','startAt','timezone','address','status'].filter(k => data[k] !== undefined).map(k => [k, data[k]]));
}
export async function putAppointment(root, id, data, expectedRevision) {
  const clean = validate(data), file = recordPath(root, id);
  await mkdir(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  await mkdir(lock); // Fail closed on a concurrent or interrupted writer.
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    let previous;
    try { previous = await getAppointment(root, id); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (Number(expectedRevision) !== (previous?.revision || 0)) throw new Error('Revision conflict; read the appointment before updating');
    if (previous && ['channel','destination','startAt','timezone'].some(k => previous[k] !== clean[k])) throw new Error('Route/time changes require explicit reminder reconciliation; create a new appointment instead');
    const result = { ...clean, id, revision: (previous?.revision || 0) + 1, updatedAt: new Date().toISOString() };
    await writeFile(tmp, JSON.stringify(result, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(tmp, file);
    return result;
  } finally {
    await rm(tmp, { force: true });
    await rm(lock, { recursive: true });
  }
}
export function appointmentPrompt(record, prompt) {
  return `Before any reminder delivery, read schedule-agent-task action=appointment-get appointmentId=${record.id}. Require channel=${record.channel} and destination=${record.destination} and startAt=${record.startAt}. If lookup fails, identity differs, or status is cancelled, do not send. Use the current title and address, not stale copied fields. Do not infer rescheduling. Send at most once; never retry uncertain delivery.\n${prompt}`;
}
