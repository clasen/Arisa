import {access, mkdir, readFile, realpath, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function validDomain(domain) {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain || '')) throw Error('Exact DNS domain required');
  return domain;
}
export async function loadRegistrations(file) {
  try { const value=JSON.parse(await readFile(file,'utf8')); if(value.version!==1 || !Array.isArray(value.sites)) throw Error('Invalid site registration state'); return value; }
  catch(e) { if(e.code==='ENOENT')return {version:1,sites:[]};throw e; }
}
export async function registerSite({file,backupRoot,allowedRoot,chatId,domain,sitePath}) {
  validDomain(domain);
  if(!chatId || !path.isAbsolute(sitePath || ''))throw Error('Chat and absolute site path required');
  const root=await realpath(allowedRoot),target=await realpath(sitePath);
  if(!target.startsWith(root+path.sep))throw Error('Site must be inside this chat state');
  await access(path.join(target,'index.js'));
  const prior=await loadRegistrations(file);
  const existing=prior.sites.find(s=>s.domain===domain);
  if(existing && existing.chatId!==String(chatId))throw Error('Site belongs to another chat');
  const backupId=randomUUID(),backupDir=path.join(backupRoot,backupId);
  await mkdir(backupDir,{recursive:true,mode:0o700});
  await writeFile(path.join(backupDir,'registrations.json'),JSON.stringify(prior,null,2),{mode:0o600});
  const next={version:1,sites:[...prior.sites.filter(s=>s.domain!==domain),{domain,sitePath:target,chatId:String(chatId)}]};
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.'+backupId+'.tmp';
  await writeFile(temporary,JSON.stringify(next,null,2),{mode:0o600});
  if(JSON.stringify(await loadRegistrations(file))!==JSON.stringify(prior))throw Error('Registration changed concurrently; reconcile before retry');
  await rename(temporary,file);
  return {domain,sitePath:target,backupId,reloadRequired:true};
}
export async function applyRegistrations(server,file) {
  const state=await loadRegistrations(file);
  for(const site of state.sites)server.register(validDomain(site.domain),site.sitePath);
}
