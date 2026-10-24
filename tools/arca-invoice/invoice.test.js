import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {makeDraft,prepare,loadDraft,issueOnce,detailXml,validateDraft,validateReceipt,reconcile} from './invoice.js';
// Synthetic fixtures only. These identifiers do not authorize any real operation.
const config={CUIT:'20123456789',POINT_OF_SALE:7,ENVIRONMENT:'homologation'};
const input={amount:'1234.56',date:'20250115',from:'20250101',to:'20250131',due:'20250115'};
const draft=()=>makeDraft(input,config);
const response=n=>({FeCabResp:{Resultado:'A',PtoVta:'7',CbteTipo:'11'},FeDetResp:{FECAEDetResponse:{Resultado:'A',Concepto:'2',DocTipo:'99',DocNro:'0',CbteDesde:String(n),CbteHasta:String(n),CbteFch:input.date,CAE:'12345678901234',CAEFchVto:'20250125'}}});
async function fixture(fn){const root=await fs.mkdtemp(path.join(os.tmpdir(),'arca-test-'));try{const d=draft();const {draftId}=await prepare(root,d);const loaded=await loadDraft(root,draftId,config);await fn({...loaded,root,approval:draftId});}finally{await fs.rm(root,{recursive:true,force:true});}}
test('Exact cents and C totals',()=>{assert.match(detailXml(draft(),1),/<ImpNeto>1234.56<\/ImpNeto>/);assert.match(detailXml(draft(),1),/<CondicionIVAReceptorId>5<\/CondicionIVAReceptorId>/);});
test('Identification threshold is inclusive',()=>assert.throws(()=>makeDraft({...input,amount:'10000000.00'},config)));
test('Rejects decimal ambiguity',()=>assert.throws(()=>makeDraft({...input,amount:'1.234,56'},config)));
test('Rejects impossible dates',()=>assert.throws(()=>makeDraft({...input,date:'20250230'},config)));
test('Rejects reversed service period',()=>assert.throws(()=>makeDraft({...input,from:'20250201'},config)));
test('Rejects due date before issue',()=>assert.throws(()=>makeDraft({...input,due:'20250114'},config)));
test('No extra fiscal classes',()=>assert.throws(()=>validateDraft({...draft(),type:1})));
test('Drafts are content-addressed and identity scoped',()=>fixture(async f=>{assert.equal((await prepare(f.root,f.draft)).draftId,f.approval);await assert.rejects(loadDraft(f.root,f.approval,{...config,POINT_OF_SALE:8}));}));
test('Only exact draft approval can issue',()=>fixture(async f=>{let sent=0;await assert.rejects(issueOnce({...f,approval:'wrong',lastNumber:async()=>0,submit:async()=>{sent++;}}));assert.equal(sent,0);}));
test('Persist before send; authorized replay does not resend',()=>fixture(async f=>{let sent=0;const args={...f,lastNumber:async()=>0,submit:async n=>{assert.equal(JSON.parse(await fs.readFile(path.join(f.dir,'issuance.json'))).status,'submitting');sent++;return response(n);}};assert.equal((await issueOnce(args)).status,'authorized');assert.equal((await issueOnce(args)).number,1);assert.equal(sent,1);}));
test('Timeout never blindly resubmits',()=>fixture(async f=>{let sent=0;const args={...f,lastNumber:async()=>0,submit:async()=>{sent++;throw new Error('timeout');}};await assert.rejects(issueOnce(args),/uncertain/);await assert.rejects(issueOnce(args),/reconciliation/);assert.equal(sent,1);}));
test('Malformed approval is uncertain not success',()=>fixture(async f=>{await assert.rejects(issueOnce({...f,lastNumber:async()=>0,submit:async()=>({})}),/reconcile/);assert.equal(JSON.parse(await fs.readFile(path.join(f.dir,'issuance.json'))).status,'uncertain');}));
test('Mismatch response sequence is rejected',()=>assert.throws(()=>validateReceipt(draft(),1,response(2))));
test('Rejected response is persisted and never auto-retried',()=>fixture(async f=>{const args={...f,lastNumber:async()=>0,submit:async()=>({FeCabResp:{Resultado:'R'},FeDetResp:{FECAEDetResponse:{Resultado:'R'}}})};assert.equal((await issueOnce(args)).status,'rejected');await assert.rejects(issueOnce(args));}));
test('Reconcile requires exact fiscal payload',()=>fixture(async f=>{await assert.rejects(issueOnce({...f,lastNumber:async()=>0,submit:async()=>{throw Error('timeout');}}));const ResultGet={Resultado:'A',EmisionTipo:'CAE',CodAutorizacion:'12345678901234',FchVto:'20250125',PtoVta:'7',CbteTipo:'11',CbteDesde:'1',CbteHasta:'1',CbteFch:input.date,Concepto:'2',DocTipo:'99',DocNro:'0',ImpTotal:input.amount,ImpNeto:input.amount,ImpIVA:'0',ImpTrib:'0',ImpTotConc:'0',ImpOpEx:'0',MonId:'PES',MonCotiz:'1',FchServDesde:input.from,FchServHasta:input.to,FchVtoPago:input.due};await assert.rejects(reconcile({...f,lookup:async()=>({ResultGet:{...ResultGet,ImpTotal:'1'}})}));assert.equal((await reconcile({...f,lookup:async()=>({ResultGet})})).status,'authorized');}));
