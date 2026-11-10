import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {makeDraft,prepare,loadDraft,detailXml,issueOnce} from './invoice.js';
const config={CUIT:'20123456789',POINT_OF_SALE:7,ENVIRONMENT:'homologation'};
const input={amount:'1234.56',date:'20250115',from:'20250101',to:'20250115',due:'20250115'};
test('Transfer label persists, changes approval hash, but does not change WSFE fields',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'arca-transfer-'));
 try {
  const cash=await prepare(root,makeDraft(input,config));
  const transfer=await prepare(root,makeDraft({...input,saleCondition:'Transferencia'},config));
  assert.notEqual(cash.draftId,transfer.draftId);
  const loaded=await loadDraft(root,transfer.draftId,config);
  assert.equal(loaded.draft.saleCondition,'Transferencia');
  assert.equal(detailXml(cash.draft,1),detailXml(loaded.draft,1));
  await assert.rejects(issueOnce({...loaded,approval:cash.draftId,lastNumber:async()=>{throw Error('must not query');},submit:async()=>{throw Error('must not submit');}}),/Explicit approval/);
 } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('Default remains Contado; unsupported labels rejected',()=>{
 assert.equal(makeDraft(input,config).saleCondition,'Contado');
 for(const saleCondition of ['Other','transferencia','',null]) assert.throws(()=>makeDraft({...input,saleCondition:saleCondition===null?{}:saleCondition},config));
});
