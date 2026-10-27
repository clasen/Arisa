import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeOutgoingMedia, patchOutgoingMediaSource } from '../send-media-compat.js';

test('model internals cannot overwrite message identity or initialization', () => {
  const media = { __x_id: undefined, __initialized: true, parent: {}, mirror: {}, caption: 'test', clientUrl: 'synthetic', uploadhash: 'hash', toJSON: () => ({ type: 'document', filename: 'test.docx', mediaKey: 'synthetic' }) };
  const attributes = { id: 'new-message', ...serializeOutgoingMedia(media) };
  assert.equal(attributes.id, 'new-message');
  assert.equal(attributes.filename, 'test.docx');
  assert.equal(attributes.caption, 'test');
  assert.equal(attributes.uploadhash, 'hash');
  for (const key of ['__x_id', '__initialized', 'parent', 'mirror', 'toJSON']) assert.equal(Object.hasOwn(attributes, key), false);
  assert.equal(media.__initialized, true);
});
test('plain sticker objects and text-only empty media stay intact', () => {
  const sticker = { type: 'sticker', filehash: 'test', mediaKey: 'test' };
  assert.equal(serializeOutgoingMedia(sticker), sticker);
  assert.deepEqual(serializeOutgoingMedia({}), {});
});
test('public JSON fields for images, audio and documents are retained', () => {
  for (const type of ['image', 'audio', 'ptt', 'video', 'document']) {
    const data = { type, mimetype: 'test/type', size: 123, directPath: '/test', waveform: [1], isGif: false };
    assert.deepEqual(serializeOutgoingMedia({ toJSON: () => data }), data);
  }
});
test('patch is exact, idempotent and fails closed on unknown sources', () => {
  const source = '    window.WWebJS.sendMessage = async () => ({\n            ...mediaOptions,\n            ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),\n});';
  const patched = patchOutgoingMediaSource(source);
  assert.equal(patchOutgoingMediaSource(patched), patched);
  assert.ok(patched.includes('...window.WWebJS.serializeOutgoingMedia(mediaOptions)'));
  assert.throws(() => patchOutgoingMediaSource('unknown'), /Unsupported/);
});
