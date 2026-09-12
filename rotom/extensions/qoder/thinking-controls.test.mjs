import test from 'node:test';
import assert from 'node:assert/strict';
import {createQoderProvider} from './provider.mjs';
import {VERIFIED_THINKING_LEVELS,CHAT_URL} from './transport.mjs';
import {CATALOG_URL} from './catalog-auth.mjs';
import {LEGACY_URL,LEGACY_MODEL_IDS} from './legacy.mjs';
import {parseCatalog} from './catalog.mjs';
import {decodeProbeBody} from '../../../experiments/qoder-provider/probe-wire.mjs';
const levels=['off','minimal','low','medium','high','xhigh','max'];
const raw=id=>({key:id,display_name:'Fixture',source:'system',enable:true,format:'openai',max_input_tokens:200000,is_reasoning:true,thinking_config:{disabled:{},enabled:{efforts:Object.fromEntries(levels.slice(2).map(l=>[l,{...l==='high'?{is_default:true}:{}}]))}}});
// Consume the self-built event stream to its terminal event. The provider now
// owns request encoding and response translation, so a stream-time failure
// surfaces as a partial-preserving `error` event rather than a thrown Response.
async function terminal(streamPromise){const stream=await streamPromise;let last;for await(const event of stream)last=event;return last;}
async function harness(id,upstream=()=>new Response('',{status:403})){
 let catalog=raw(id),reads=0;const requests=[];
 const provider=await createQoderProvider({authMode:'qodercli',piAI:{createProvider:p=>p,lazyStream:(_m,fn)=>fn()},getCredential:async()=>{reads++;return{accessToken:'fixture',uid:'fixture',org:'',machineId:'fixture-machine',fingerprint:'a'.repeat(64)};},fetchImpl:async(url,init)=>{
  if(url===CATALOG_URL)return Response.json({assistant:[catalog]});
  assert.equal(url,LEGACY_MODEL_IDS.includes(id)?LEGACY_URL:CHAT_URL);requests.push(url===LEGACY_URL?decodeProbeBody(init.body):JSON.parse(init.body));
  return upstream();
 }});
 const refresh=()=>provider.refreshModels({force:true,allowNetwork:true,signal:new AbortController().signal,publish:async p=>{p.update?.();return true;}});
 await refresh();reads=0;
 return{provider,requests,get reads(){return reads;},model:()=>provider.getModels().find(m=>m.id===id),async replace(next){catalog=next;await refresh();reads=0;}};
}
for(const [id,allowed] of Object.entries(VERIFIED_THINKING_LEVELS))test(`${id}: only reviewed/current efforts appear, and native controls reach the exact wire`,async()=>{
 const h=await harness(id),model=h.model();
 assert.deepEqual(levels.filter(l=>typeof model.thinkingLevelMap[l]==='string'),allowed);
 for(const level of allowed){
  // Upstream 403 is an eager pre-stream failure: the request is encoded and
  // dispatched (captured below) before openQoderStream rejects.
  await assert.rejects(h.provider.api.streamSimple(model,{messages:[]},{...level==='off'?{}:{reasoning:level}}),{code:'http_403'});
  const wire=h.requests.at(-1),effort=level==='off'?'none':level;
  if(LEGACY_MODEL_IDS.includes(id)){assert.equal(wire.parameters.reasoning_effort,effort);assert.equal(wire.parameters.enable_thinking,level!=='off');assert.equal(wire.model_config.is_reasoning,level!=='off');assert.equal(wire.chat_context.extra.modelConfig.is_reasoning,level!=='off');}
  else{assert.equal(wire.reasoning_effort,effort);assert.equal(wire.enable_thinking,level!=='off');}
 }
 assert.equal(h.requests.length,allowed.length);
});
test('unreviewed/off/budget/cross-API controls fail before auth and dispatch',async()=>{
 const h=await harness('ultimate');
 for(const options of [{reasoning:'off'},{reasoning:'minimal'},{reasoning:'unknown'},{reasoningEffort:'high'},{reasoning:'high',thinkingBudgets:{high:10}}])await assert.rejects(h.provider.api.streamSimple(h.model(),{messages:[]},options),/reasoning_controls_not_validated/);
 await assert.rejects(h.provider.api.stream(h.model(),{messages:[]},{reasoning:'high'}),/reasoning_controls_not_validated/);
 assert.equal(h.reads,0);assert.equal(h.requests.length,0);
 await assert.rejects(h.provider.api.stream(h.model(),{messages:[]},{reasoningEffort:'low'}),{code:'http_403'});assert.equal(h.requests[0].parameters.reasoning_effort,'low');
});
test('off is explicit in simple API; native raw none is supported without cross-API aliasing',async()=>{
 const h=await harness('qmodel_38max');await assert.rejects(h.provider.api.streamSimple(h.model(),{messages:[]},{reasoning:'none'}),/reasoning_controls_not_validated/);assert.equal(h.reads,0);
 for(const [method,options] of [['streamSimple',{reasoning:'off'}],['stream',{reasoningEffort:'none'}]]){
  await assert.rejects(h.provider.api[method](h.model(),{messages:[]},options),{code:'http_403'});assert.equal(h.requests.at(-1).parameters.reasoning_effort,'none');assert.equal(h.requests.at(-1).parameters.enable_thinking,false);
 }
});
test('an off request cannot silently accept reasoning returned by the service',async()=>{
 const h=await harness('qmodel_38max',()=>new Response('data: '+JSON.stringify({statusCodeValue:200,body:JSON.stringify({choices:[{delta:{reasoning_content:'fixture'},finish_reason:null}]})})+'\n\n',{headers:{'content-type':'text/event-stream'}}));
 const last=await terminal(h.provider.api.streamSimple(h.model(),{messages:[]},{}));
 assert.equal(last.type,'error');assert.match(last.error.errorMessage,/reasoning_not_validated/);assert.equal(h.requests.length,1);
});
test('post-hook effort/boolean substitution fails even if the replacement effort is also allowed',async()=>{
 const h=await harness('smodel');
 for(const onPayload of [p=>{p.reasoning_effort='low';},p=>{p.enable_thinking=false;},p=>{delete p.reasoning_effort;}]){
  await assert.rejects(h.provider.api.streamSimple(h.model(),{messages:[]},{reasoning:'high',onPayload}),{code:'reasoning_mode_rejected'});
 }
 assert.equal(h.reads,0);assert.equal(h.requests.length,0);
});
test('current catalog restricts a stale model object, with no upward substitution',async()=>{
 const h=await harness('ultimate'),old=h.model(),next=raw('ultimate');next.thinking_config.enabled.efforts={low:{is_default:true}};await h.replace(next);
 assert.deepEqual(levels.filter(l=>h.model().thinkingLevelMap[l]!==null),['low']);
 await assert.rejects(h.provider.api.streamSimple(old,{messages:[]},{reasoning:'high'}),/reasoning_controls_not_validated/);assert.equal(h.reads,0);
 await assert.rejects(h.provider.api.streamSimple(old,{messages:[]},{}),{code:'http_403'});assert.equal(h.requests[0].parameters.reasoning_effort,'low');
});
test('missing/malformed and unreviewed catalog controls cannot invent new effort capabilities',async()=>{
 for(const config of [undefined,null,{enabled:{efforts:{low:null}}}]){
  const h=await harness('ultimate'),next=raw('ultimate');next.thinking_config=config;await h.replace(next);
  assert.equal(h.model().thinkingLevelMap.medium,'enabled');assert.equal(h.model().compat.supportsReasoningEffort,false);
  await assert.rejects(h.provider.api.streamSimple(h.model(),{messages:[]},{reasoning:'high'}),/reasoning_controls_not_validated/);
 }
 const g=await harness('gmodel');assert.equal(g.model().thinkingLevelMap.medium,'enabled');
 const entry=raw('ultimate');entry.thinking_config.enabled.efforts.PRIVATE={description:'PRIVATE'};
 const parsed=parseCatalog({assistant:[entry]})[0].reportedThinking;assert.doesNotMatch(JSON.stringify(parsed),/PRIVATE/);assert(Object.isFrozen(parsed.efforts));
});
