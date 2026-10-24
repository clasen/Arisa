import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {X509Certificate,createPrivateKey,createPublicKey} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import defaults from './config.js';
import {makeDraft,prepare,loadDraft,issueOnce,issueEnvelope,reconcile} from './invoice.js';
import {endpoints,escapeXml,parseXml,validateIdentity,wsfeEnvelope,postXml} from './protocol.js';
const toolName='arca-invoice';
const help=`arca-invoice\n\nUsage:\n  node index.js --help\n  node index.js run --request-file <json>\n\nActions via args.action:\n  inspect-certificate  Verify local certificate identity, validity and matching private key.\n  connectivity         Unauthenticated FEDummy request with strict TLS; no fiscal writes.\n  read-status          Authenticate to WSAA, list points of sale and query last authorized C invoice.\n\nConfiguration: CUIT, POINT_OF_SALE, ENVIRONMENT (homologation or production).\nCredentials must be in chat tool state credentials/arca-<environment>.key and .crt.\nNo credentials appear in output. Authentication tickets are stored privately per environment.\nActions also include prepare (args.draft JSON), issue (args.draftId and args.approval matching the approved hash), reconcile and export-pdf (args.draftId, optional style=classic|modern and copies=original|all; defaults classic and original). Only C professional services in ARS for unidentified consumers below the verified limit are supported. No automatic network retries or TLS downgrades.\n`;
const exec=promisify(execFile);
async function core(relative){if(!process.env.ARISA_PACKAGE_DIR)throw new Error('ARISA_PACKAGE_DIR is required');return import(pathToFileURL(path.join(process.env.ARISA_PACKAGE_DIR,'src',relative)).href);}
async function inspectCertificate(dir,config){
 const base=path.join(dir,'credentials',`arca-${config.ENVIRONMENT}`);
 const cert=new X509Certificate(await fs.readFile(base+'.crt'));
 const key=createPrivateKey(await fs.readFile(base+'.key'));
 if(!cert.publicKey.export({type:'spki',format:'der'}).equals(createPublicKey(key).export({type:'spki',format:'der'})))throw new Error('Certificate and private key do not match');
 if(!cert.subject.split('\n').includes(`serialNumber=CUIT ${config.CUIT}`))throw new Error('Certificate CUIT mismatch');
 if(Date.now()<Date.parse(cert.validFrom)||Date.now()>=Date.parse(cert.validTo))throw new Error('Certificate is outside validity period');
 const stat=await fs.stat(base+'.key');if((stat.mode & 0o077)!==0)throw new Error('Private key permissions must exclude group and other access');
 return {base,validFrom:cert.validFrom,validTo:cert.validTo,fingerprint:cert.fingerprint256};
}
async function getTicket(dir,tmp,config,certificate){
 const cache=path.join(dir,`ticket-${config.ENVIRONMENT}.json`);
 try {const ticket=JSON.parse(await fs.readFile(cache,'utf8'));if(ticket.fingerprint===certificate.fingerprint && Date.parse(ticket.expirationTime)>Date.now()+120000)return ticket;}catch(error){if(error.code!=='ENOENT')throw new Error('Ticket cache unreadable; manual reconciliation required');}
 await fs.mkdir(tmp,{recursive:true,mode:0o700});const scratch=await fs.mkdtemp(path.join(tmp,'wsaa-'));
 try {
  const now=Date.now();const login=`<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(now/1000)}</uniqueId><generationTime>${new Date(now-600000).toISOString()}</generationTime><expirationTime>${new Date(now+600000).toISOString()}</expirationTime></header><service>wsfe</service></loginTicketRequest>`;
  const input=path.join(scratch,'request.xml'),output=path.join(scratch,'signed.der');await fs.writeFile(input,login,{mode:0o600});
  await exec('openssl',['cms','-sign','-in',input,'-signer',certificate.base+'.crt','-inkey',certificate.base+'.key','-nodetach','-outform','DER','-out',output],{timeout:15000});
  const cms=(await fs.readFile(output)).toString('base64');
  const xml=`<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><loginCms xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov"><in0>${cms}</in0></loginCms></soap:Body></soap:Envelope>`;
  const response=await postXml(endpoints[config.ENVIRONMENT].wsaa,xml,'""');
  const ticket=parseXml(response.loginCmsResponse?.loginCmsReturn??'').loginTicketResponse;
  if(!ticket?.credentials?.token||!ticket?.credentials?.sign||!ticket.header?.expirationTime)throw new Error('WSAA returned an incomplete ticket');
  const stored={...ticket.credentials,expirationTime:ticket.header.expirationTime,fingerprint:certificate.fingerprint};
  await fs.writeFile(cache,JSON.stringify(stored),{mode:0o600});return stored;
 }finally{await fs.rm(scratch,{recursive:true,force:true});await fs.rmdir(tmp).catch(()=>{});}
}
async function query(config,method,payload=''){
 const body=await postXml(endpoints[config.ENVIRONMENT].wsfe,wsfeEnvelope(method,payload),`"http://ar.gov.afip.dif.FEV1/${method}"`);
 const result=body[method+'Response']?.[method+'Result'];if(!result)throw new Error('Unexpected WSFE response');return result;
}
async function run(request){
 if(!request.chatId)throw new Error('chatId is required');
 const {loadToolConfig}=await core('core/tools/tool-config.js');
 const {getChatToolStateDir,getChatToolTmpDir}=await core('runtime/paths.js');
 const config=await loadToolConfig(toolName,defaults,request.chatId);validateIdentity(config);
 const dir=getChatToolStateDir(request.chatId,toolName);await fs.mkdir(dir,{recursive:true,mode:0o700});
 const action=request.args?.action??'inspect-certificate';
 if(!['inspect-certificate','connectivity','read-status','prepare','issue','reconcile','export-pdf'].includes(action))throw new Error('Unknown action');
 if(action==='prepare')return prepare(dir,makeDraft(JSON.parse(request.args.draft),config));
 if(action==='export-pdf'){const {exportPdf}=await import('./pdf.js');return exportPdf(await loadDraft(dir,request.args.draftId,config),config,{style:request.args.style,copies:request.args.copies});}
 const certificate=await inspectCertificate(dir,config);
 if(action==='inspect-certificate')return {environment:config.ENVIRONMENT,pointOfSale:Number(config.POINT_OF_SALE),keyMatches:true,validFrom:certificate.validFrom,validTo:certificate.validTo,issuanceEnabled:true};
 // Fail before creating a ticket if WSFE cannot be reached securely.
 const health=await query(config,'FEDummy');
 if(action==='connectivity')return {environment:config.ENVIRONMENT,health,issuanceEnabled:true};
 const lock=path.join(dir,`read-status-${config.ENVIRONMENT}.lock`);let handle;
 try{handle=await fs.open(lock,'wx',0o600);}catch{throw new Error('Another authentication operation or unresolved lock exists');}
 try {
  const ticket=await getTicket(dir,getChatToolTmpDir(request.chatId,toolName),config,certificate);
  const auth=`<Auth><Token>${escapeXml(ticket.token)}</Token><Sign>${escapeXml(ticket.sign)}</Sign><Cuit>${config.CUIT}</Cuit></Auth>`;
  if(action==='issue'||action==='reconcile'){
   const loaded=await loadDraft(dir,request.args.draftId,config);const {draft}=loaded;
   if(action==='reconcile')return reconcile({...loaded,lookup:n=>query(config,'FECompConsultar',`${auth}<FeCompConsReq><CbteTipo>11</CbteTipo><CbteNro>${n}</CbteNro><PtoVta>${draft.point}</PtoVta></FeCompConsReq>`)});
   const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
   if(draft.date!==today)throw new Error('Issuance requires today’s Argentina date; prepare a newly approved draft if the date changed');
   if(config.COMPLIANCE_REVIEW_DATE!==today)throw new Error('Current official consumer identification rules must be reviewed before issuance');
   if(!config.ISSUER_NAME||!config.ISSUER_ADDRESS||!config.ISSUER_IIBB||!config.ISSUER_START)throw new Error('Issuer printable data must be configured before issuance');
   const entries=await fs.readdir(path.join(dir,'invoices'));
   for(const id of entries){try{const record=JSON.parse(await fs.readFile(path.join(dir,'invoices',id,'issuance.json')));if(['submitting','uncertain'].includes(record.status))throw new Error('An unresolved issuance exists; reconcile before issuing');}catch(e){if(e.code!=='ENOENT')throw e;}}
   const points=await query(config,'FEParamGetPtosVenta',auth);const list=points.ResultGet?.PtoVenta;const point=(Array.isArray(list)?list:[list]).find(p=>Number(p?.Nro)===draft.point);
   if(points.Errors||!point||point.Bloqueado!=='N'||point.EmisionTipo!=='CAE - Monotributo'||(point.FchBaja&&point.FchBaja!=='NULL'))throw new Error('Point of sale is not verified for issuance');
   const conditions=await query(config,'FEParamGetCondicionIvaReceptor',`${auth}<ClaseCmp>C</ClaseCmp>`);const values=conditions.ResultGet?.CondicionIvaReceptor;
   if(conditions.Errors||!(Array.isArray(values)?values:[values]).some(v=>Number(v?.Id)===5))throw new Error('Consumer final VAT condition not verified');
   return issueOnce({...loaded,approval:request.args.approval,lastNumber:async()=>{const last=await query(config,'FECompUltimoAutorizado',`${auth}<PtoVta>${draft.point}</PtoVta><CbteTipo>11</CbteTipo>`);if(last.Errors||Number(last.PtoVta)!==draft.point||Number(last.CbteTipo)!==11||!/^[0-9]+$/.test(last.CbteNro??''))throw new Error('Last invoice could not be verified');return Number(last.CbteNro);},submit:async n=>{const body=await postXml(endpoints[config.ENVIRONMENT].wsfe,issueEnvelope(auth,draft,n),'"http://ar.gov.afip.dif.FEV1/FECAESolicitar"');return body.FECAESolicitarResponse?.FECAESolicitarResult;}});
  }
  const points=await query(config,'FEParamGetPtosVenta',auth);
  const last=await query(config,'FECompUltimoAutorizado',`${auth}<PtoVta>${Number(config.POINT_OF_SALE)}</PtoVta><CbteTipo>11</CbteTipo>`);
  const result={checkedAt:new Date().toISOString(),environment:config.ENVIRONMENT,health,points,last,issuanceEnabled:true};
  await fs.writeFile(path.join(dir,`status-${config.ENVIRONMENT}.json`),JSON.stringify(result,null,2),{mode:0o600});return result;
 }finally{await handle.close();await fs.unlink(lock);}
}
if(process.argv.includes('--help')||process.argv.length===2)console.log(help);
else {
 try{
  if(process.argv[2]!=='run'||!process.argv.includes('--request-file'))throw new Error('Use run --request-file <json>');
  const request=JSON.parse(await fs.readFile(process.argv[process.argv.indexOf('--request-file')+1],'utf8'));
  const result=await run(request);console.log(JSON.stringify({ok:true,output:result.filePath?result:{json:result,text:JSON.stringify(result),mimeType:'application/json'}}));
 }catch(error){console.log(JSON.stringify({ok:false,status:'failed',error:error.message}));}
}
