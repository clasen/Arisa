import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { resolveMediaBlob } from '../media-compat.js';

function setup({ stage = 'RESOLVED', cache = true, fallback = false } = {}) {
  let downloads = 0;
  const blob = new Blob(['audio']);
  const message = {
    mediaData: { mediaStage: stage }, mediaObject: { filehash: 'test', ...(fallback ? { mediaBlob: { forceToBlob: () => blob } } : {}) },
    mimetype: 'audio/ogg', size: 5,
    downloadMedia: async (options) => { assert.equal(options.isUserInitiated, true); downloads++; }
  };
  const context = vm.createContext({ window: { require: (name) => {
    if (name === 'WAWebCollections') return { Msg: { get: () => message } };
    if (name === 'WAWebMediaInMemoryBlobCache') return { InMemoryMediaBlobCache: { get: () => cache ? blob : null } };
    throw Error('Unexpected internal dependency');
  } } });
  const run = vm.runInContext(`(${resolveMediaBlob.toString()})`, context);
  return { run, count: () => downloads, blob };
}

test('uses native download even when media stage is RESOLVED', async () => {
  const t = setup();
  const result = await t.run('message');
  assert.equal(result.blob, t.blob);
  assert.equal(t.count(), 1);
});
test('uses mediaObject blob if in-memory cache is empty', async () => {
  const t = setup({ cache: false, fallback: true });
  assert.equal((await t.run('message')).blob, t.blob);
});
test('unavailable media returns no fabricated data', async () => {
  const t = setup({ cache: false });
  assert.equal(await t.run('message'), null);
});
test('does not attempt download during reupload', async () => {
  const t = setup({ stage: 'REUPLOADING' });
  assert.equal(await t.run('message'), null);
  assert.equal(t.count(), 0);
});
