import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSSE,createQoderFetch,CHAT_URL,QODER_REASONING_FORMAT,SONUS_REASONING_FORMAT,reasoningDetailsToItem,validateReasoningSignature} from './transport.mjs';
import {createQoderProvider} from './provider.mjs';
import {CATALOG_URL} from './catalog-auth.mjs';
import {LEGACY_URL} from './legacy.mjs';
import {decodeProbeBody} from '../../../experiments/qoder-provider/probe-wire.mjs';
const legacyArgs={legacyModel:{id:'ultimate',name:'Ultimate',enabled:true,reviewed:true,format:'openai',reportedContextWindow:1000000,contextWindow:32000},getLegacyCredential:()=>({accessToken:'fixture',uid:'fixture',org:'',machineId:'fixture-machine'})};
const item={id:'rs_fixture',encrypted_content:'opaque-fixture-data'};
const details=[{type:'reasoning.encrypted',format:QODER_REASONING_FORMAT,id:item.id,data:item.encrypted_content}];
const frame=delta=>`data: ${JSON.stringify({choices:[{delta,finish_reason:null}]})}\n\n`;
const end=`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`;
async function normalize(wire,options={allowReasoning:true,allowOpaqueReasoning:true}){let result='';for await(const chunk of normalizeSSE(new Response(wire).body,options))result+=chunk;return result;}
test('Ultimate item uses the native reasoning signature contract without altering opaque bytes',async()=>{
  const output=await normalize(frame({reasoning_content:'text'})+frame({reasoning_item:item})+end);
  const chunk=JSON.parse(output.split('\n\n')[1].slice(6));assert.deepEqual(chunk.choices[0].delta.reasoning_details,details);
  assert.deepEqual(reasoningDetailsToItem(details),item);validateReasoningSignature(JSON.stringify(details));
});
test('Sonus preserves target_hash in a model-specific native signature without decoding ciphertext',async()=>{
  const sonus={...item,target_hash:'t'.repeat(64)},options={allowReasoning:true,allowOpaqueReasoning:true,opaqueModelId:'smodel'};
  const output=await normalize(frame({reasoning_item:sonus})+end,options);
  const details=JSON.parse(output.split('\n\n')[0].slice(6)).choices[0].delta.reasoning_details;
  assert.equal(details[0].format,SONUS_REASONING_FORMAT);assert.deepEqual(reasoningDetailsToItem(details,'smodel'),sonus);validateReasoningSignature(JSON.stringify(details),'smodel');
  assert.throws(()=>reasoningDetailsToItem(details,'ultimate'),/opaque_reasoning_replay_unsupported/);
  for(const bad of [{...sonus,target_hash:'short'},{...sonus,extra:'private'},item])await assert.rejects(normalize(frame({reasoning_item:bad})+end,options),/opaque_reasoning_replay_unsupported/);
  assert.throws(()=>reasoningDetailsToItem([{...details[0],id:'wrong'}],'smodel'),/opaque_reasoning_replay_unsupported/);
});
test('Sonus/Ultimate function_call terminal translates only on their observed COSY protocol',async()=>{
  const data={choices:[{delta:{tool_calls:[{index:0,id:'call',type:'function',function:{name:'probe',arguments:'{}'}}]},finish_reason:'function_call'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
  const wire='data: '+JSON.stringify({statusCodeValue:200,body:JSON.stringify(data)})+'\n\ndata: '+JSON.stringify({firstTokenDuration:1,totalDuration:2,serverDuration:1})+'\n\n';
  const opts={allowReasoning:true,allowOpaqueReasoning:true,opaqueModelId:'smodel',allowLegacyEnvelope:true,allowLegacyMetricsDone:true,toolNames:['probe']};
  assert.match(await normalize(wire,opts),/tool_calls/);
  assert.match(await normalize(wire,{...opts,opaqueModelId:'ultimate'}),/tool_calls/);
  await assert.rejects(normalize(wire,{...opts,opaqueModelId:'gmodel'}),/invalid_finish_reason/);
  await assert.rejects(normalize('data: '+JSON.stringify(data)+'\n\ndata: [DONE]\n\n',{...opts,opaqueModelId:'ultimate',allowLegacyEnvelope:false}),/invalid_finish_reason/);
  const malformed=structuredClone(data);malformed.choices[0].delta.tool_calls[0].function.arguments='{';
  await assert.rejects(normalize('data: '+JSON.stringify({statusCodeValue:200,body:JSON.stringify(malformed)})+'\n\ndata: [DONE]\n\n',{...opts,opaqueModelId:'ultimate'}),/invalid_tool_arguments/);
  await assert.rejects(normalize(wire,{...opts,toolNames:[]}),/invalid_tool_call/);
});
test('opaque support stays opt-in and duplicate/unknown/partial items fail closed',async()=>{
  await assert.rejects(normalize(frame({reasoning_item:item})+end,{allowReasoning:true}),/opaque_reasoning_replay_unsupported/);
  await assert.rejects(normalize(frame({reasoning_item:item})+frame({reasoning_item:item})+end));
  for(const value of [{id:'only'},{...item,extra:'private'},{...item,id:'\n'},{...item,encrypted_content:'x'.repeat(65537)}])await assert.rejects(normalize(frame({reasoning_item:value})+end));
  await assert.rejects(normalize(frame({reasoning_details:details})+end));
  await assert.rejects(normalize(frame({reasoning_content_signature:'not supported'})+end));
});
test('observed Ultimate stop without delta is supported without inventing terminal evidence',async()=>{
  const terminal='data: '+JSON.stringify({choices:[{index:0,finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n';
  assert.match(await normalize(frame({content:'text'})+terminal),/\"delta\":\{\}/);
  await assert.rejects(normalize(terminal,{allowReasoning:true}),/invalid_delta/);
  await assert.rejects(normalize(terminal.replace(',\"finish_reason\":\"stop\"','')),/invalid_delta/);
  await assert.rejects(normalize(terminal.replace('data: [DONE]\n\n','')),/incomplete_stream/);
  await assert.rejects(normalize('data: '+JSON.stringify({choices:[{delta:null,finish_reason:'stop'}]})+'\n\n'),/invalid_delta/);
  await assert.rejects(normalize('data: '+JSON.stringify({choices:[{message:{content:'must not drop'},finish_reason:'stop'}]})+'\n\n'),/invalid_delta/);
});
test('Ultimate tool continuation may omit terminal delta but still requires complete tools and stream evidence',async()=>{
  const event=value=>'data: '+JSON.stringify(value)+'\n\n';
  const tool=argumentsText=>frame({tool_calls:[{index:0,id:'call_fixture',type:'function',function:{name:'probe',arguments:argumentsText}}]});
  const terminal=event({choices:[{index:0,finish_reason:'tool_calls'}]});
  const usage=event({choices:[],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),done='data: [DONE]\n\n';
  const opts={allowReasoning:true,allowOpaqueReasoning:true,opaqueModelId:'ultimate',toolNames:['probe']};
  const wire=tool('{"nonce":"fixture"}')+terminal+usage+done;
  const output=await normalize(wire,opts);
  assert.match(output,/"delta":\{\},"finish_reason":"tool_calls"/);
  assert.doesNotMatch(output,/reasoning_details/); // No fabricated opaque item on a non-reasoning continuation.
  await assert.rejects(normalize(terminal+usage+done,opts),/missing_tool_call/);
  await assert.rejects(normalize(tool('{')+terminal+usage+done,opts),/invalid_tool_arguments/);
  await assert.rejects(normalize(wire,{...opts,toolNames:[]}),/invalid_tool_call/);
  for(const patch of [{allowOpaqueReasoning:false},{opaqueModelId:'smodel'},{opaqueModelId:'gmodel'}])await assert.rejects(normalize(wire,{...opts,...patch}),/invalid_delta/);
  for(const choice of [{delta:null,finish_reason:'tool_calls'},{message:{content:'must not drop'},finish_reason:'tool_calls'},{finish_reason:'length'},{finish_reason:'function_call'},{}])await assert.rejects(normalize(tool('{}')+event({choices:[choice]})+usage+done,opts),/invalid_delta/);
  await assert.rejects(normalize(tool('{}')+terminal+done,opts),/incomplete_stream/);
  await assert.rejects(normalize(tool('{}')+terminal+usage,opts),/incomplete_stream/);
  await assert.rejects(normalize(tool('{}')+terminal+terminal+usage+done,opts),/invalid_finish_reason/);
  await assert.rejects(normalize(wire+frame({content:'late'}),opts),/data_after_done/);
  const meters=[];
  const fetch=createQoderFetch({...legacyArgs,modelId:'ultimate',getToken:async()=>'fixture',onMetering:m=>meters.push(m),fetchImpl:async()=>new Response((wire+frame({content:'late'})).replace(/^data: (.*)$/gm,(line,data)=>data.startsWith('[')?line:'data: '+JSON.stringify({statusCodeValue:200,body:data})),{headers:{'content-type':'text/event-stream'}})});
  const response=await fetch(CHAT_URL,{method:'POST',body:JSON.stringify({model:'ultimate',messages:[],stream:true,tools:[{type:'function',function:{name:'probe'}}]})});
  let received='';await assert.rejects((async()=>{for await(const chunk of response.body)received+=new TextDecoder().decode(chunk);})(),/data_after_done/);
  assert.doesNotMatch(received,/\[DONE\]/);assert.equal(meters.length,1);assert.equal(meters[0].status,'unknown');assert.equal(meters[0].outcome,'error');
});
test('Ultimate serial tool batches reuse zero but preserve distinct full IDs and exact arguments',async()=>{
  const opts={allowReasoning:true,allowOpaqueReasoning:true,opaqueModelId:'ultimate',toolNames:['probe']};
  const start=(id,args,index=0,name='probe')=>({index,id,type:'function',function:{name,arguments:args}});
  const first=start('call_first','{"n":1}'),second=start('call_second','{"n":2}');
  for(const prefix of [frame({tool_calls:[first,second]}),frame({tool_calls:[first]})+frame({tool_calls:[second]})]){
    const output=await normalize(prefix+end,opts),tools=output.split('\n\n').filter(s=>s.startsWith('data: {')).flatMap(s=>JSON.parse(s.slice(6)).choices.flatMap(c=>c.delta.tool_calls??[]));
    assert.deepEqual(tools.map(t=>[t.index,t.id,t.function.arguments]),[[0,'call_first','{"n":1}'],[1,'call_second','{"n":2}']]);
    await assert.rejects(normalize(prefix+end,{...opts,opaqueModelId:'smodel'}),/invalid_tool_id/);
  }
  const chunks=frame({tool_calls:[first]})+frame({tool_calls:[start('call_second','{"n":')]})+frame({tool_calls:[{index:0,id:'',function:{arguments:'2}'}}]});
  assert.match(await normalize(chunks+end,opts),/call_second/);
  for(const [a,b] of [[start('call_first','{'),second],[first,start('call_first_suffix','{}')],[first,start('call_second','{}',0,'unknown')],[first,{index:0,id:'call_second',function:{arguments:'{}'}}],[first,start(null,'{}')],[first,start('x'.repeat(513),'{}')],[start('call_first','{}',1),start('call_second','{}',1)]])await assert.rejects(normalize(frame({tool_calls:[a,b]})+end,opts),/invalid_tool_id/);
  await assert.rejects(normalize(frame({tool_calls:[first,second,first]})+end,opts),/invalid_tool_id/);
  await assert.rejects(normalize(frame({tool_calls:[first,start('call_second','{')]})+end,opts),/invalid_tool_arguments/);
  const many=Array.from({length:65},(_,n)=>start(`call_${String(n).padStart(3,'0')}`,'{}'));
  await assert.rejects(normalize(frame({tool_calls:many})+end,opts),/invalid_tool_delta/);
  // A genuine later index 1 must not collide with a rebased slot at index 1.
  const mixed=await normalize(frame({tool_calls:[first,second,start('call_third','{}',1)]})+end,opts);
  assert.match(mixed,/"index":2,"type":"function","function":\{"name":"probe","arguments":"\{\}"\},"id":"call_third"/);
});
test('malformed/foreign/multiple signature details are rejected with sanitized errors',()=>{
  for(const value of [[],[...details,...details],[{...details[0],format:'another-provider'}],[{...details[0],type:'reasoning.text'}],[{...details[0],extra:'PRIVATE'}]])assert.throws(()=>reasoningDetailsToItem(value),/^QoderError: Qoder: opaque_reasoning_replay_unsupported$/);
  assert.throws(()=>validateReasoningSignature('PRIVATE_NOT_JSON'),/^QoderError: Qoder: opaque_reasoning_replay_unsupported$/);
});
test('native details are converted back only on Ultimate assistant turns before token lookup',async()=>{
  let reads=0,body;const make=modelId=>createQoderFetch({...legacyArgs,modelId,getToken:async()=>{reads++;return 'fixture';},fetchImpl:async(url,init)=>{assert.equal(url,LEGACY_URL);body=decodeProbeBody(init.body);return new Response('',{status:403});}});
  const request=(model,messages)=>make(model)(CHAT_URL,{method:'POST',body:JSON.stringify({model,messages,stream:true})});
  await assert.rejects(request('ultimate',[{role:'assistant',content:null,reasoning_details:details}]),/http_403/);
  assert.deepEqual(body.messages[0].reasoning_item,item);assert.equal(body.messages[0].reasoning_details,undefined);assert.equal(body.model_config.is_reasoning,true);assert.equal(body.parameters.reasoning_effort,'high');assert.equal(reads,1);
  for(const [model,message] of [['gmodel',{role:'assistant',reasoning_details:details}],['ultimate',{role:'user',reasoning_details:details}],['ultimate',{role:'assistant',reasoning_item:item}],['ultimate',{role:'assistant',reasoning_details:[{...details[0],format:'foreign'}]}]])await assert.rejects(request(model,[message]));
  assert.equal(reads,1);
});
test('same-model signatures are validated while foreign history is converted before dispatch',async()=>{
  // Same-model opaque replay remains strict; foreign signatures cannot replay
  // and are removed by the builder, rather than blocking the entire handoff.
  let dispatches=0;const p=await createQoderProvider({authMode:'qodercli',getCredential:async()=>({accessToken:'fixture',uid:'fixture',machineId:'fixture-machine',org:'',fingerprint:'a'.repeat(64)}),piAI:{createProvider:x=>x,lazyStream:(_m,fn)=>fn()},fetchImpl:async url=>{if(url===CATALOG_URL)return new Response(JSON.stringify({assistant:[{key:'ultimate',display_name:'Ultimate',source:'system',enable:true,format:'openai',max_input_tokens:200000}]}));dispatches++;return new Response('',{status:403});}});
  await p.refreshModels({allowNetwork:true,signal:new AbortController().signal,publish:async p=>{p.update?.();return true;}});
  const model=p.getModels()[0];const message={role:'assistant',provider:'qoder-experimental',model:'ultimate',api:'qoder',content:[{type:'thinking',thinking:'text',thinkingSignature:JSON.stringify(details)}]};
  await assert.rejects(p.api.streamSimple(model,{messages:[message]},{}),{code:'http_403'});assert.equal(dispatches,1);
  for(const patch of [{provider:'foreign'},{model:'gmodel'},{api:'other'}])await assert.rejects(p.api.streamSimple(model,{messages:[{...message,...patch}]},{}),{code:'http_403'});
  for(const content of [[{type:'toolCall',thoughtSignature:JSON.stringify(details[0])}],[{type:'thinking',thinking:'text',thinkingSignature:'invalid'}]])await assert.rejects(p.api.streamSimple(model,{messages:[{...message,content}]},{}),/opaque_reasoning_replay_unsupported/);
  assert.equal(dispatches,4);
});
