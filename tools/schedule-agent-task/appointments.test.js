import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { putAppointment, getAppointment, appointmentPrompt, recordPath } from './appointments.js';
test('versioned details, route protection and cancellation without rescheduling', async () => {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'appointment-test-'));
 try {
  const data = {channel:'whatsapp',destination:'test@lid',title:'Appointment',startAt:'2026-10-26T11:00:00-03:00',timezone:'America/Argentina/Buenos_Aires',status:'confirmed'};
  const a = await putAppointment(dir,'sample',data,0);
  assert.equal(a.revision,1);
  const b = await putAppointment(dir,'sample',{...data,address:'Example 173'},1);
  assert.equal(b.revision,2);
  await assert.rejects(putAppointment(dir,'sample',data,1), /Revision conflict/);
  await assert.rejects(putAppointment(dir,'sample',{...data,destination:'other@lid'},2), /Route\/time/);
  const c = await putAppointment(dir,'sample',{...data,status:'cancelled'},2);
  assert.equal((await getAppointment(dir,'sample')).status,'cancelled');
  assert.match(appointmentPrompt(c,'Reminder'), /appointment-get/);
  assert.throws(()=>recordPath(dir,'../escape'));
 } finally { await rm(dir,{recursive:true,force:true}); }
});
