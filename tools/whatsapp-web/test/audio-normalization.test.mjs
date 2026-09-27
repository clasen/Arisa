import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAudio } from '../audio-normalization.js';
const sleep = async () => {};

test('downloads once and transcribes successfully', async () => {
  let downloads = 0;
  const result = await normalizeAudio({ sleep, download: async () => { downloads++; return { id: 'audio' }; }, transcribe: async () => 'hello' });
  assert.equal(result.transcript, 'hello');
  assert.equal(downloads, 1);
});
test('retries transcription without downloading twice', async () => {
  let downloads = 0, calls = 0;
  const result = await normalizeAudio({ sleep, download: async () => { downloads++; return { id: 'audio' }; }, transcribe: async () => { if (++calls === 1) throw Error('offline'); return 'hello'; } });
  assert.equal(result.status, 'completed');
  assert.equal(downloads, 1);
  assert.equal(calls, 2);
});
test('empty transcripts are failures, not user text', async () => {
  let calls = 0;
  const result = await normalizeAudio({ sleep, download: async () => ({ id: 'audio' }), transcribe: async () => { calls++; return '  '; } });
  assert.equal(result.error, 'transcription_failed');
  assert.equal(result.transcript, '');
  assert.equal(result.artifact.id, 'audio');
  assert.equal(calls, 3);
});
for (const throws of [false, true]) {
  test(`download failure does not trigger another download or transcription (throws=${throws})`, async () => {
    let calls = 0, downloads = 0;
    const result = await normalizeAudio({ sleep, download: async () => { downloads++; if (throws) throw Error('unavailable'); return null; }, transcribe: async () => { calls++; } });
    assert.equal(result.error, 'download_failed');
    assert.equal(downloads, 1);
    assert.equal(calls, 0);
  });
}
