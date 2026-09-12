// Native SDK regression for the maintainer-chosen 272000 window: inside the
// compaction-governed regime the next answer keeps 4096, and an oversized single
// turn provably loses answer budget. Both outcomes are asserted, not hidden.
// Synthetic upstream only. Run with the maintenance network blocker.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {readFileSync,realpathSync} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {decodeProbeBody} from './probe-wire.mjs';
const root=process.env.ROTOM_QODER_PROBE_PRODUCT_ROOT??resolve(import.meta.dirname,'../../rotom'),pi=process.env.ROTOM_PI;
assert(isAbsolute(root)&&realpathSync(root)===root&&pi&&isAbsolute(pi)&&realpathSync(pi)===pi&&process.execArgv.includes('--experimental-import-meta-resolve'));
const piURL=pathToFileURL(pi).href,piAI=await import(import.meta.resolve('@earendil-works/pi-ai',piURL)),openAI=await import(import.meta.resolve('@earendil-works/pi-ai/api/openai-completions',piURL));
const {createQoderProvider}=await import(pathToFileURL(join(root,'extensions/qoder/provider.mjs')).href),{CATALOG_URL}=await import(pathToFileURL(join(root,'extensions/qoder/catalog-auth.mjs')).href),{LEGACY_URL}=await import(pathToFileURL(join(root,'extensions/qoder/legacy.mjs')).href);
const cases=[];
for(const id of ['ultimate','kmodel_latest','dfmodel']){
 let serializedMaxTokens=0,calls=0;
 const provider=await createQoderProvider({piAI,openAI,authMode:'qodercli',getCredential:async()=>({accessToken:'fixture',uid:'fixture',org:'',machineId:'fixture-machine',fingerprint:'a'.repeat(64)}),fetchImpl:async(url,init)=>{
  if(url===CATALOG_URL)return Response.json({assistant:[{key:id,display_name:'Synthetic',source:'system',enable:true,format:'openai',is_vl:true,max_input_tokens:1000000,context_config:{'400K':{token_count:400000}}}]});
  assert.equal(url,LEGACY_URL);calls++;const body=decodeProbeBody(init.body);assert.equal(body.parameters.context_length,400000);serializedMaxTokens=body.parameters.max_tokens;return new Response('',{status:403});
 }});
 await provider.refreshModels({allowNetwork:true,signal:new AbortController().signal,publish:async p=>p.update()});
 const model=provider.getModels().find(m=>m.id===id);assert.equal(model.contextWindow,272000);
 const history=input=>({messages:[{role:'user',content:'Synthetic previous request',timestamp:Date.now()},{role:'assistant',provider:model.provider,model:id,api:model.api,timestamp:Date.now(),content:[{type:'text',text:'Synthetic previous answer'}],stopReason:'stop',usage:{input,output:100,cacheRead:0,cacheWrite:0,totalTokens:input+100,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}},{role:'user',content:'Continue synthetically',timestamp:Date.now()}]});
 // 244000 stays inside the maintainer's reserveTokens=27200 compaction trigger.
 const governed=await provider.streamSimple(model,history(244000),{maxTokens:4096}).result();assert.equal(governed.stopReason,'error');assert.equal(calls,1);assert.equal(serializedMaxTokens,4096);
 // An oversized single turn cannot be compacted away; record the real cliff.
 const starved=await provider.streamSimple(model,history(272000),{maxTokens:4096}).result();assert.equal(starved.stopReason,'error');assert.equal(calls,2);assert.equal(serializedMaxTokens,1);
 cases.push({id,pass:true,contextWindow:model.contextWindow,governedInput:244000,governedMaxTokens:4096,oversizedInput:272000,oversizedMaxTokens:serializedMaxTokens,fullOutputInputCeiling:model.contextWindow-8192});
}
console.log(JSON.stringify({pass:true,scope:'offline real native SDK, synthetic upstream',productRoot:root,piEntry:pi,piEntrySha256:createHash('sha256').update(readFileSync(pi)).digest('hex'),cases},null,2));
