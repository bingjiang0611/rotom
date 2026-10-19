import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSSE,reasoningDetailsToItem,validateReasoningSignature,createQoderFetch,openQoderStream,CHAT_URL,ULTIMATE_COSY_REASONING_FORMAT,QODER_REASONING_FORMAT} from './transport.mjs';
import {translateQoderStream} from './translate.mjs';
import {LEGACY_URL} from './legacy.mjs';
import {decodeProbeBody} from '../../../experiments/qoder-provider/probe-wire.mjs';
const item={id:'fixture',encrypted_content:'opaque-fixture',target_hash:'h'.repeat(64)};
const options={allowReasoning:true,allowOpaqueReasoning:true,opaqueModelId:'ultimate',allowLegacyEnvelope:true};
const frame=d=>'data: '+JSON.stringify({statusCodeValue:200,body:JSON.stringify(d)})+'\n\n';
function wire(value){return frame({choices:[{delta:{reasoning_item:value},finish_reason:null}]})+frame({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'data: [DONE]\n\n';}
async function collect(value,opts=options){let s='';for await(const f of normalizeSSE(new Response(wire(value)).body,opts))s+=f;return JSON.parse(s.split('\n\n')[0].slice(6)).choices[0].delta.reasoning_details;}
test('Ultimate COSY preserves all three fields under its own signature, not the Sonus identity',async()=>{
 const details=await collect(item);assert.equal(details[0].format,ULTIMATE_COSY_REASONING_FORMAT);assert.deepEqual(reasoningDetailsToItem(details,'ultimate'),item);validateReasoningSignature(JSON.stringify(details),'ultimate');
 assert.throws(()=>reasoningDetailsToItem(details,'smodel'),/opaque_reasoning_replay_unsupported/);
 for(const value of [{...item,extra:1},{...item,target_hash:'short'}])await assert.rejects(collect(value),/opaque_reasoning_replay_unsupported/);
 const wrong=structuredClone(details);wrong[0].id='different';assert.throws(()=>reasoningDetailsToItem(wrong),/opaque_reasoning_replay_unsupported/);
});
test('the original two-field Ultimate signature remains byte-preserving',async()=>{
 const old={id:item.id,encrypted_content:item.encrypted_content},details=await collect(old);assert.equal(details[0].format,QODER_REASONING_FORMAT);assert.deepEqual(reasoningDetailsToItem(details),old);
});
test('a direct HTTP response cannot silently acquire the COSY schema',async()=>{
 const raw='data: '+JSON.stringify({choices:[{delta:{reasoning_item:item},finish_reason:null}]})+'\n\n';
 await assert.rejects(async()=>{for await(const f of normalizeSSE(new Response(raw).body,{...options,allowLegacyEnvelope:false}))void f;},/opaque_reasoning_replay_unsupported/);
});
test('fixed COSY dispatch translates serial zero-index read calls into distinct native tools',async()=>{
 const delta=tool_calls=>frame({choices:[{delta:{tool_calls},finish_reason:null}]});
 const tool=(id,args,name='read')=>({index:0,id,type:'function',function:{name,arguments:args}});
 const body=delta([tool('call_first','{"path":"first.md"}')])+delta([tool('call_second','{"path":')])+delta([tool('','"second.md"}','')])+frame({choices:[{delta:{},finish_reason:'function_call'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'data: [DONE]\n\n';
 const diagnostics=[];let requests=0;
 const {chunks}=await openQoderStream({
  modelId:'ultimate',legacyModel:{id:'ultimate',name:'Ultimate',enabled:true,reviewed:true,format:'openai',reportedContextWindow:1000000,contextWindow:32000},
  getToken:()=> 'fixture',getLegacyCredential:()=>({accessToken:'fixture',uid:'fixture',org:'',machineId:'fixture-machine'}),
  payload:{model:'ultimate',stream:true,messages:[{role:'user',content:'Read two fixture files.'}],tools:[{type:'function',function:{name:'read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}]},
  onDiagnostic:d=>diagnostics.push(d),
  fetchImpl:(url,init)=>{requests++;assert.equal(url,LEGACY_URL);assert.equal(decodeProbeBody(init.body).model_config.key,'ultimate');return new Response(body,{headers:{'content-type':'text/event-stream'}});},
 });
 let result;
 for await(const event of translateQoderStream(chunks,{id:'ultimate',provider:'qoder',api:'qoder'}))if(event.type==='done'||event.type==='error')result=event.message??event.error;
 assert.equal(result.stopReason,'toolUse');
 assert.deepEqual(result.content,[{type:'toolCall',id:'call_first',name:'read',arguments:{path:'first.md'}},{type:'toolCall',id:'call_second',name:'read',arguments:{path:'second.md'}}]);
 assert.equal(requests,1);assert.deepEqual(diagnostics,[]);
});
test('both Ultimate signatures use one fixed COSY dispatch; HTTP rejection never falls back',async()=>{
 const details=await collect(item),old={id:'older-fixture',encrypted_content:'older-opaque'},oldDetails=[{type:'reasoning.encrypted',format:QODER_REASONING_FORMAT,id:old.id,data:old.encrypted_content}];let auth=0,calls=0;
 const fetch=createQoderFetch({modelId:'ultimate',legacyModel:{id:'ultimate',name:'Ultimate',enabled:true,reviewed:true,format:'openai',reportedContextWindow:1000000,contextWindow:32000},getLegacyCredential:()=>({accessToken:'fixture',uid:'fixture',org:'',machineId:'fixture-machine'}),getToken:()=>{auth++;return 'fixture';},fetchImpl:(url,init)=>{calls++;assert.equal(url,LEGACY_URL);assert.deepEqual(decodeProbeBody(init.body).messages.map(m=>m.reasoning_item),[old,item]);return new Response('',{status:403});}});
 await assert.rejects(fetch(CHAT_URL,{method:'POST',body:JSON.stringify({model:'ultimate',stream:true,messages:[oldDetails,details].map(reasoning_details=>({role:'assistant',content:'',reasoning_details}))})}),/http_403/);assert.equal(auth,1);assert.equal(calls,1);
});
