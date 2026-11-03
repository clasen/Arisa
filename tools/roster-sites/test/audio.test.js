import {test} from 'node:test';
import assert from 'node:assert/strict';
import {audioRange} from '../audio-route.js';
import {withAudioRoutes} from '../audio-deploy.js';
test('audio ranges support browser probes, suffixes, and open ends',()=>{
 assert.equal(audioRange(undefined,100),null);
 assert.deepEqual(audioRange('bytes=0-1',100),{start:0,end:1});
 assert.deepEqual(audioRange('bytes=90-',100),{start:90,end:99});
 assert.deepEqual(audioRange('bytes=-10',100),{start:90,end:99});
 assert.deepEqual(audioRange('bytes=90-200',100),{start:90,end:99});
 for(const v of ['bytes=100-','bytes=2-1','bytes=-0','bytes=-','bytes=0-1,3-4']) assert.equal(audioRange(v,100),false);
});
test('audio handler is installed before custom routes and is idempotent',()=>{
 const source='    const customRoutes = await loadCustomRoutes();';
 const patched=withAudioRoutes(source);
 assert.ok(patched.indexOf('if (await serveAudio') < patched.indexOf(source));
 assert.equal(withAudioRoutes(patched),patched);
 assert.throws(()=>withAudioRoutes('unsupported'));
});
