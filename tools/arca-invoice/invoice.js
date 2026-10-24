import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {escapeXml} from './protocol.js';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function validateDraft(d){
 if(!/^\d+\.\d{2}$/.test(d.amount))throw new Error('Amount must use fixed two-decimal notation');
 const cents=BigInt(d.amount.replace('.',''));if(cents<=0n||cents>=1000000000n)throw new Error('This flow only supports unidentified consumers below ARS 10,000,000');
 for(const field of ['date','from','to','due']){if(!/^\d{8}$/.test(d[field]))throw new Error('Dates must be YYYYMMDD');const iso=d[field].replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');if(!Number.isFinite(Date.parse(iso))||new Date(iso).toISOString().slice(0,10)!==iso)throw new Error('Invalid date');}
 if(d.from>d.to||d.due<d.date)throw new Error('Invalid service period or due date');
 if(d.description!=='Servicios profesionales'||d.saleCondition!=='Contado')throw new Error('Only professional services paid cash/on delivery are supported');
 if(d.type!==11||d.concept!==2||d.docType!==99||d.docNumber!==0||d.vatCondition!==5||d.currency!=='PES')throw new Error('Unsupported fiscal draft');
 if(!/^\d{11}$/.test(d.cuit)||!Number.isInteger(d.point)||d.point<1||d.point>99999||!['production','homologation'].includes(d.environment))throw new Error('Invalid fiscal identity');
 return d;
}
export function makeDraft(input,config){return validateDraft({environment:config.ENVIRONMENT,cuit:String(config.CUIT),point:Number(config.POINT_OF_SALE),type:11,concept:2,docType:99,docNumber:0,vatCondition:5,currency:'PES',description:input.description??'Servicios profesionales',saleCondition:input.saleCondition??'Contado',amount:input.amount,date:input.date,from:input.from,to:input.to,due:input.due});}
export async function durableWrite(file,value){
 const tmp=file+'.tmp';const handle=await fs.open(tmp,'w',0o600);try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}
 await fs.rename(tmp,file);const dir=await fs.open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}
}
export async function prepare(root,draft){validateDraft(draft);const id=digest(draft);const dir=path.join(root,'invoices',id);await fs.mkdir(dir,{recursive:true,mode:0o700});const file=path.join(dir,'draft.json');try{await fs.writeFile(file,JSON.stringify(draft,null,2),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;const old=JSON.parse(await fs.readFile(file));if(digest(old)!==id)throw new Error('Draft storage mismatch');}return {draftId:id,draft};}
export async function loadDraft(root,id,config){if(!/^[a-f0-9]{64}$/.test(id??''))throw new Error('Invalid draft id');const dir=path.join(root,'invoices',id);const draft=validateDraft(JSON.parse(await fs.readFile(path.join(dir,'draft.json'))));if(digest(draft)!==id||draft.cuit!==String(config.CUIT)||draft.environment!==config.ENVIRONMENT||draft.point!==Number(config.POINT_OF_SALE))throw new Error('Draft identity or hash mismatch');return {dir,draft};}
export function detailXml(d,number){validateDraft(d);if(!Number.isInteger(number)||number<1||number>99999999)throw new Error('Invalid invoice sequence');const values={Concepto:2,DocTipo:99,DocNro:0,CbteDesde:number,CbteHasta:number,CbteFch:d.date,ImpTotal:d.amount,ImpTotConc:'0.00',ImpNeto:d.amount,ImpOpEx:'0.00',ImpTrib:'0.00',ImpIVA:'0.00',FchServDesde:d.from,FchServHasta:d.to,FchVtoPago:d.due,MonId:'PES',MonCotiz:'1',CondicionIVAReceptorId:5};return Object.entries(values).map(([k,v])=>`<${k}>${escapeXml(v)}</${k}>`).join('');}
export function issueEnvelope(auth,d,number){return `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitar xmlns="http://ar.gov.afip.dif.FEV1/">${auth}<FeCAEReq><FeCabReq><CantReg>1</CantReg><PtoVta>${d.point}</PtoVta><CbteTipo>11</CbteTipo></FeCabReq><FeDetReq><FECAEDetRequest>${detailXml(d,number)}</FECAEDetRequest></FeDetReq></FeCAEReq></FECAESolicitar></soap:Body></soap:Envelope>`;}
export function validateReceipt(d,n,result){const h=result?.FeCabResp;const r=result?.FeDetResp?.FECAEDetResponse;if(h?.Resultado!=='A'||Number(h.PtoVta)!==d.point||Number(h.CbteTipo)!==11||r?.Resultado!=='A'||!/^\d{14}$/.test(r.CAE??'')||!/^\d{8}$/.test(r.CAEFchVto??'')||Number(r.CbteDesde)!==n||Number(r.CbteHasta)!==n||r.CbteFch!==d.date||Number(r.DocTipo)!==99||Number(r.DocNro)!==0||Number(r.Concepto)!==2)throw new Error('Unverified authorization response; reconcile before any further issue');return {number:n,cae:r.CAE,caeExpires:r.CAEFchVto};}
export async function issueOnce({dir,draft,approval,lastNumber,submit}){
 if(approval!==digest(draft))throw new Error('Explicit approval must equal draft hash');
 const file=path.join(dir,'issuance.json');
 try{const old=JSON.parse(await fs.readFile(file));if(old.status==='authorized')return old;throw new Error(`Issuance already recorded as ${old.status}; only reconciliation is allowed`);}catch(e){if(e.code!=='ENOENT')throw e;}
 const number=await lastNumber();if(!Number.isInteger(number)||number<0||number>=99999999)throw new Error('Invalid last authorized number');
 const record={status:'submitting',number:number+1,draftHash:digest(draft),approvedAt:new Date().toISOString()};await durableWrite(file,record);
 let response;
 try{response=await submit(record.number);await durableWrite(path.join(dir,'response.json'),response);}catch{record.status='uncertain';await durableWrite(file,record);throw new Error('Submission outcome uncertain; do not retry. Run reconcile.');}
 if(response?.FeCabResp?.Resultado==='R'&&response?.FeDetResp?.FECAEDetResponse?.Resultado==='R'){record.status='rejected';record.response=response;await durableWrite(file,record);return record;}
 try{Object.assign(record,validateReceipt(draft,record.number,response),{status:'authorized',response});}catch{record.status='uncertain';await durableWrite(file,record);throw new Error('Response not verified; reconcile, never retry');}
 await durableWrite(file,record);return record;
}
export function validateReconciliation(d,n,result){const r=result?.ResultGet;if(result?.Errors||!r||r.Resultado!=='A'||r.EmisionTipo!=='CAE'||!/^\d{14}$/.test(r.CodAutorizacion??'')||Number(r.PtoVta)!==d.point||Number(r.CbteTipo)!==11||Number(r.CbteDesde)!==n||Number(r.CbteHasta)!==n||r.CbteFch!==d.date||Number(r.Concepto)!==2||Number(r.DocTipo)!==99||Number(r.DocNro)!==0||Number(r.ImpTotal)!==Number(d.amount)||Number(r.ImpNeto)!==Number(d.amount)||Number(r.ImpIVA)!==0||Number(r.ImpTrib)!==0||Number(r.ImpTotConc)!==0||Number(r.ImpOpEx)!==0||r.MonId!=='PES'||Number(r.MonCotiz)!==1||r.FchServDesde!==d.from||r.FchServHasta!==d.to||r.FchVtoPago!==d.due||!/^\d{8}$/.test(r.FchVto??''))throw new Error('Reconciliation absent or mismatched; do not retry issuance');return {number:n,cae:r.CodAutorizacion,caeExpires:r.FchVto};}
export async function reconcile({dir,draft,lookup}){const file=path.join(dir,'issuance.json');const record=JSON.parse(await fs.readFile(file));if(record.draftHash!==digest(draft))throw new Error('Issuance draft mismatch');const response=await lookup(record.number);await durableWrite(path.join(dir,'reconciliation.json'),response);Object.assign(record,validateReconciliation(draft,record.number,response),{status:'authorized',reconciledAt:new Date().toISOString()});await durableWrite(file,record);return record;}
