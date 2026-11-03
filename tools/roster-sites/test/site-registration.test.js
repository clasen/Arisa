import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {registerSite,loadRegistrations,applyRegistrations,validDomain} from '../site-registration.js';
test('registration preserves other domains, owner boundary and exact rollback metadata',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'roster-register-'));
 try{
 const site=path.join(root,'chat','server');await fs.mkdir(site,{recursive:true});await fs.writeFile(path.join(site,'index.js'),'export default ()=>{}');
 const file=path.join(root,'registrations.json');await fs.writeFile(file,JSON.stringify({version:1,sites:[{domain:'other.test',sitePath:'/other',chatId:'2'}]}));
 const args={file,backupRoot:path.join(root,'backups'),allowedRoot:path.join(root,'chat'),chatId:'1',domain:'example.test',sitePath:site};
 const r=await registerSite(args);assert.equal(r.reloadRequired,true);assert.equal((await loadRegistrations(file)).sites.length,2);
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'backups',r.backupId,'registrations.json'))).sites.length,1);
 await assert.rejects(registerSite({...args,chatId:'2'}),/another chat/);
 await assert.rejects(registerSite({...args,sitePath:root}),/inside/);
 const calls=[];await applyRegistrations({register:(...a)=>calls.push(a)},file);assert.equal(calls[1][1],site);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('domain cannot contain URLs or paths',()=>{for(const d of ['../x','https://example.test','example.test/x',''])assert.throws(()=>validDomain(d));});
