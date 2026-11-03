import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { validateBundle, readBundle } from '../static-deploy.js';
import { createStaticHandler, requestFile } from '../static-handler.js';

const entry = (name, text) => ({path: name, base64: Buffer.from(text).toString('base64')});
test('reads JSON from a text artifact or BOM-prefixed file artifact', async () => {
  const bundle = {files:[entry('index.html','wallet')]};
  assert.deepEqual(await readBundle({artifact:{text:JSON.stringify(bundle)}}),bundle);
  assert.deepEqual(await readBundle({text:JSON.stringify(bundle)}),bundle);
  await assert.rejects(readBundle({artifact:{text:'not json'}}));
  await assert.rejects(readBundle({}));
  const dir = await mkdtemp(path.join(os.tmpdir(),'roster-bundle-test-'));
  try {
    const file = path.join(dir,'bundle.json');
    await writeFile(file,'\uFEFF'+JSON.stringify(bundle),'utf8');
    assert.deepEqual(await readBundle({artifact:{path:file}}),bundle);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('validates a nested static bundle including WASM', () => {
  const result = validateBundle({files: [entry('index.html', 'wallet'), entry('assets/secp.wasm', '\0asm'), entry('probes/wallet/probe.js', 'export {}')]});
  assert.equal(result.files.size, 3);
});
test('rejects unsafe paths, reserved handlers, duplicates, malformed bytes and absent entry', () => {
  for (const name of ['../key', '/index.html', 'a/../key', 'a//key', '.env', 'index.js', 'package.json', 'a\\key']) {
    assert.throws(() => validateBundle({files: [entry('index.html', 'ok'), entry(name, 'bad')]}));
  }
  assert.throws(() => validateBundle({files: [entry('index.html', 'ok'), entry('index.html', 'dup')]}));
  assert.throws(() => validateBundle({files: [{path:'index.html',base64:'!invalid'}]}));
  assert.throws(() => validateBundle({files: [entry('style.css', '')]}));
});
test('request parser rejects traversal and malformed escapes', () => {
  assert.equal(requestFile('/'), 'index.html');
  assert.equal(requestFile('/assets/x.wasm?v=1'), 'assets/x.wasm');
  for (const url of ['/%2e%2e/key', '/a/../key', '/%zz', '/a%5ckey', '/%00']) assert.equal(requestFile(url), null);
});
test('serves current release, MIME and HEAD without exposing deployment or source files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'roster-static-test-'));
  await mkdir(path.join(root,'static-releases','abc'), {recursive:true});
  await writeFile(path.join(root,'static-releases','abc','index.html'), 'wallet');
  await writeFile(path.join(root,'static-releases','abc','test.wasm'), Buffer.from([0,97,115,109]));
  await writeFile(path.join(root,'static-current.json'), JSON.stringify({release:'abc',files:['index.html','test.wasm']}));
  const server = http.createServer(createStaticHandler(root));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(url);
    assert.equal(await response.text(), 'wallet');
    assert.match(response.headers.get('content-type'), /charset=UTF-8/);
    response = await fetch(`${url}/test.wasm`, {method:'HEAD'});
    assert.equal(response.headers.get('content-type'), 'application/wasm');
    assert.equal(response.headers.get('content-length'), '4');
    assert.equal(await response.text(), '');
    for (const name of ['static-current.json', 'index.js', 'package.json', 'missing.js']) assert.equal((await fetch(`${url}/${name}`)).status,404);
    assert.equal((await fetch(url,{method:'POST'})).status,405);
    await writeFile(path.join(root,'static-releases','abc','index.html'),'new wallet');
    assert.equal(await (await fetch(url)).text(),'new wallet');
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root,{recursive:true,force:true}); }
});
