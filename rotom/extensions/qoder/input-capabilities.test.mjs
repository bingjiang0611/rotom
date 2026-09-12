import test from 'node:test';
import assert from 'node:assert/strict';
import {createQoderProvider} from './provider.mjs';
import {SUPPORTED_MODEL_IDS,EXPANDED_INPUT_MODEL_IDS,imageByteLength,checkImageTotal,IMAGE_LIMITS} from './transport.mjs';
import {CATALOG_URL} from './catalog-auth.mjs';
import {LEGACY_URL} from './legacy.mjs';
import {parseCatalog} from './catalog.mjs';
import {decodeProbeBody} from '../../../experiments/qoder-provider/probe-wire.mjs';
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(16)]).toString('base64');
const image={type:'image',mimeType:'image/png',data:png};
const raw=id=>({key:id,display_name:'Fixture',source:'system',enable:true,format:'openai',is_vl:true,max_input_tokens:id==='kmodel_latest'?180000:1000000,context_config:{'400K':{token_count:400000}}});
async function harness(id){
 let entry=raw(id),reads=0;const requests=[];
 const p=await createQoderProvider({authMode:'qodercli',piAI:{createProvider:p=>p,lazyStream:(_m,fn)=>fn()},getCredential:async()=>{reads++;return{accessToken:'fixture',uid:'fixture',org:'',machineId:'fixture-machine',fingerprint:'a'.repeat(64)};},fetchImpl:async(url,init)=>{if(url===CATALOG_URL)return Response.json({assistant:[entry]});requests.push({url,body:decodeProbeBody(init.body)});return new Response('',{status:403});}});
 const refresh=()=>p.refreshModels({force:true,allowNetwork:true,signal:new AbortController().signal,publish:async v=>v.update()});await refresh();reads=0;
 return{p,requests,model:()=>p.getModels().find(m=>m.id===id),get reads(){return reads;},async update(patch){entry={...entry,...patch};await refresh();reads=0;}};
}
for(const id of EXPANDED_INPUT_MODEL_IDS)test(`${id}: reviewed images and the Codex-aligned 272K managed window require current catalog, with fixed 400K COSY selector`,async()=>{
 const h=await harness(id),model=h.model();assert.deepEqual(model.input,['text','image']);assert.equal(model.contextWindow,272000);assert.equal(model.maxTokens,4096);
 // Upstream 403 is an eager pre-stream failure; the encoded request is captured before openQoderStream rejects.
 await assert.rejects(h.p.api.streamSimple(model,{messages:[{role:'user',content:[image]},{role:'toolResult',content:[image]}]},{}),{code:'http_403'});assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,LEGACY_URL);
 const b=h.requests[0].body;assert.equal(b.parameters.context_length,400000);assert.equal(b.parameters.max_tokens,4096);
 // The COSY image contract mirrors content into contents; text-only messages (e.g. the split tool result) legitimately carry no contents array.
 for(const m of b.messages.filter(m=>Array.isArray(m.content)))assert.deepEqual(m.contents,m.content);
 await h.update({context_config:undefined});assert.equal(h.model().contextWindow,32000);await assert.rejects(h.p.api.streamSimple(model,{messages:[]},{}),/catalog_changed_select_again/);assert.equal(h.reads,0);
 await h.update({is_vl:false});assert.deepEqual(h.model().input,['text']);await assert.rejects(h.p.api.streamSimple(h.model(),{messages:[{role:'user',content:[image]}]},{}),/images_not_validated/);assert.equal(h.reads,0);
});
test('all other fourteen keys remain text-only and at most 32K despite advertised selectors and vision',async()=>{
 assert.equal(new Set(SUPPORTED_MODEL_IDS).size,17);
 for(const id of SUPPORTED_MODEL_IDS.filter(id=>!EXPANDED_INPUT_MODEL_IDS.includes(id))){const h=await harness(id);assert.equal(h.model().contextWindow,32000);assert.deepEqual(h.model().input,['text']);await assert.rejects(h.p.api.streamSimple(h.model(),{messages:[{role:'user',content:[image]}]},{}),/images_not_validated/);assert.equal(h.reads,0);}
});
test('startup declarations expose reviewed maxima, but unavailable accounts cannot dispatch them',async()=>{
 let reads=0;const p=await createQoderProvider({authMode:'qodercli',getCredential:async()=>{reads++;},piAI:{createProvider:p=>p,lazyStream:(_m,fn)=>fn()}});
 assert.deepEqual(p.filterModels(p.models).map(m=>m.id),['lite','performance']);
 for(const id of EXPANDED_INPUT_MODEL_IDS){const declared=p.models.find(m=>m.id===id);assert.equal(declared.contextWindow,272000);assert.deepEqual(declared.input,['text','image']);await assert.rejects(p.api.streamSimple(declared,{messages:[{role:'user',content:[image]}]},{}),/catalog_refresh_required/);}
 assert.equal(reads,0);
});
test('malformed/absent selector declarations do not enable extra capacity',()=>{
 for(const c of [undefined,null,[],{'400K':{token_count:'400000'}},{'400K':{token_count:1000000}},{'1M':{token_count:1000000}}])assert.equal(parseCatalog({assistant:[{...raw('ultimate'),context_config:c}]})[0].contextWindow,32000);
 for(const patch of [{enable:false},{format:'unknown'}])assert.equal(parseCatalog({assistant:[{...raw('ultimate'),...patch}]})[0].contextWindow,32000);
});
test('invalid images, remote URLs, unknown aliases, higher selectors and role overrides fail before auth',async()=>{
 const h=await harness('ultimate');
 for(const block of [{...image,mimeType:'image/gif'},{...image,data:png+'\n'},{...image,data:'AAAA'},{...image,data:''}])await assert.rejects(h.p.api.streamSimple(h.model(),{messages:[{role:'user',content:[block]}]},{}),/invalid_image/);
 await assert.rejects(h.p.api.streamSimple(h.model(),{messages:[{role:'assistant',content:[image]}]},{}),/images_not_validated/);
 // onPayload runs after the payload is built; openQoderStream re-validates it, so a hook cannot smuggle an oversized window, a remote image URL, an unknown message key or an assistant-role image past the gate.
 for(const onPayload of [b=>{b.context_length=1000000;},b=>{b.messages=[{role:'user',contents:[{type:'image_url',image_url:{url:'https://example.invalid/private'}}]}];},b=>{b.messages=[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.invalid/private'}}]}];},b=>{b.messages=[{role:'assistant',content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+png}}]}];}]){
  await assert.rejects(h.p.api.streamSimple(h.model(),{messages:[]},{onPayload}));
 }
 assert.equal(h.reads,0);assert.equal(h.requests.length,0);
});
test('image byte/count limits are bounded and canonical base64 is required',()=>{
 assert.equal(imageByteLength(png,'image/png'),24);
 assert.throws(()=>imageByteLength('AAAA'.repeat(Math.ceil(IMAGE_LIMITS.singleBytes/3)+1),'image/png'),/image_limits_rejected/);
 assert.throws(()=>checkImageTotal(33,1),/image_limits_rejected/);assert.throws(()=>checkImageTotal(1,IMAGE_LIMITS.totalBytes+1),/image_limits_rejected/);
 assert.throws(()=>imageByteLength('AQ==','image/jpeg'),/invalid_image/);
});
