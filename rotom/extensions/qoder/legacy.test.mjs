import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyBody,legacyHeaders,LEGACY_URL,LEGACY_MODEL_IDS} from './legacy.mjs';
import {createQoderFetch,normalizeSSE,CHAT_URL} from './transport.mjs';
const entry={id:'dfmodel',name:'Flash',format:'openai',enabled:true,reviewed:true,reportedContextWindow:1000000,contextWindow:32000,reportedImages:true,reportedReasoning:true};
const credential={accessToken:'PRIVATE_TOKEN',uid:'fixture',machineId:'fixture-machine'};
const payload=()=>({model:'dfmodel',stream:true,messages:[{role:'system',content:'synthetic system'},{role:'user',content:'synthetic input'}],max_tokens:32});
const frame=data=>'data: '+JSON.stringify({statusCodeValue:200,body:typeof data==='string'?data:JSON.stringify(data)})+'\n\n';
const terminal={choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
const wire=()=>frame(terminal)+frame('[DONE]');
async function normalize(text,options={allowLegacyEnvelope:true}){let out='';for await(const f of normalizeSSE(new Response(text).body,options))out+=f;return out;}
const decode=value=>{
  const normal='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',custom='_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$';
  const base=[...value].map(c=>normal[custom.indexOf(c)]).join(''),n=base.length,a=Math.floor(n/3);
  return JSON.parse(Buffer.from(base.slice(n-a)+base.slice(a,n-a)+base.slice(0,a),'base64').toString('utf8'));
};
test('legacy body preserves messages/tools/reasoning and fixes conservative scope',()=>{
  const p=payload();p.messages.push({role:'assistant',content:'',reasoning_content:'plain fixture',tool_calls:[{id:'call',type:'function',function:{name:'probe',arguments:'{}'}}]},{role:'tool',tool_call_id:'call',content:'result'});p.tools=[{type:'function',function:{name:'probe'}}];
  const body=decode(legacyBody(p,entry,'request','session'));
  assert.equal(body.system,'synthetic system');assert.deepEqual(body.messages,p.messages.slice(1));assert.deepEqual(body.tools,p.tools);
  assert.equal(body.session_id,'session');assert.equal(body.request_id,'request');assert.equal(body.is_retry,false);assert.equal(body.model_config.api_key,'');assert.equal(body.model_config.url,'');assert.equal(body.parameters.reasoning_effort,'high');assert.equal(body.parameters.context_length,32000);assert.equal(body.parameters.max_tokens,32);
  assert.equal(body.chat_context.extra.context.length,0);assert.equal(body.business,undefined);
  p.messages[2].content=null;const normalized=decode(legacyBody(p,entry,'request','session'));assert.equal(normalized.messages[1].content,'');assert.equal(normalized.messages[1].reasoning_content,'plain fixture');assert.deepEqual(normalized.messages[1].tool_calls,p.messages[2].tool_calls);
  assert.throws(()=>legacyBody({...p,unknown_override:true},entry,'a','b'),/legacy_request_field_unsupported/);
  assert.throws(()=>legacyBody(p,{...entry,reviewed:false},'a','b'),/legacy_model_metadata_required/);
});
test('each declared legacy route keeps exact catalog/body/header identity',()=>{
  for(const id of LEGACY_MODEL_IDS){
    const body=legacyBody({...payload(),model:id},{...entry,id},'request','session');
    assert.equal(decode(body).model_config.key,id);assert.equal(legacyHeaders(credential,body,id)['X-Model-Key'],id);
    assert.throws(()=>legacyBody({...payload(),model:id},{...entry,id:'wrong'},'r','s'),/legacy_model_metadata_required/);
  }
  assert.throws(()=>legacyHeaders(credential,'body','unreviewed'),/legacy_model_metadata_required/);
});
test('requested fixed reasoning mode wins over informational catalog flags',()=>{
  for(const enabled of [true,false]){
    const p={...payload(),enable_thinking:enabled};const body=decode(legacyBody(p,{...entry,reportedReasoning:!enabled},'request','session'));
    assert.equal(body.model_config.is_reasoning,enabled);assert.equal(body.chat_context.extra.modelConfig.is_reasoning,enabled);assert.equal(body.parameters.reasoning_effort,enabled?'high':'none');
  }
});
test('legacy envelope is opt-in, preserves DONE/usage and rejects status/error/truncation',async()=>{
  assert.match(await normalize(wire()),/OK/);
  await assert.rejects(normalize(wire(),{}),/invalid_choices/);
  await assert.rejects(normalize(wire().replace('200','403')),/upstream_error_frame/);
  await assert.rejects(normalize(frame('[DONE]')),/incomplete_stream/);
  await assert.rejects(normalize(frame(terminal)),/incomplete_stream/);
  await assert.rejects(normalize(frame({error:{message:'PRIVATE_ERROR'}})),e=>e.code==='upstream_error_frame'&&!e.message.includes('PRIVATE_ERROR'));
  await assert.rejects(normalize('data: '+JSON.stringify({statusCodeValue:200,body:{choices:[]}})+'\n\n'),/invalid_legacy_envelope/);
  const broken=wire().replace('OK','O\nK');assert.match(await normalize(broken),/OK/);
});
test('one exact legacy timing trailer is allowed only after proven DONE',async()=>{
  const trailer=value=>'data: '+JSON.stringify(value)+'\n\n';const timing={firstTokenDuration:1,totalDuration:2,serverDuration:0.5};
  assert.match(await normalize(wire()+trailer(timing)),/OK/);
  for(const tail of [trailer({...timing,content:'hidden'}),trailer({...timing,totalDuration:-1}),trailer({...timing,totalDuration:'2'}),trailer(timing)+trailer(timing),frame('[DONE]'),frame({error:'PRIVATE'})])await assert.rejects(normalize(wire()+tail),/data_after_done/);
  await assert.rejects(normalize(trailer(timing)+wire()),/upstream_error_frame/);
});
test('MiniMax terminal bridge needs explicit finish, real usage and exact metrics, never EOF',async()=>{
  const metrics='data: '+JSON.stringify({firstTokenDuration:1,totalDuration:2,serverDuration:1})+'\n\n';
  const options={allowLegacyEnvelope:true,allowLegacyMetricsDone:true};
  assert.match(await normalize(frame(terminal)+metrics,options),/\[DONE\]/);
  await assert.rejects(normalize(frame(terminal)+metrics),/upstream_error_frame/);
  await assert.rejects(normalize(frame(terminal),options),/incomplete_stream/);
  await assert.rejects(normalize(metrics,options),/incomplete_stream/);
  const {usage,...noUsage}=terminal;await assert.rejects(normalize(frame(noUsage)+metrics,options),/incomplete_stream/);
  await assert.rejects(normalize(frame({...terminal,choices:[{delta:{content:'x'}}]})+metrics,options),/incomplete_stream/);
  await assert.rejects(normalize(frame(terminal)+metrics+frame({error:'PRIVATE'}),options),/data_after_done/);
});
test('Flash dispatch is one explicit legacy POST, not direct then fallback',async()=>{
  let tokens=0,requests=0;
  const fetch=createQoderFetch({modelId:'dfmodel',legacyModel:entry,getToken:()=>{tokens++;return credential.accessToken;},getLegacyCredential:()=>credential,fetchImpl:async(url,init)=>{
    requests++;assert.equal(url,LEGACY_URL);assert.equal(init.redirect,'error');assert.equal(init.method,'POST');assert.match(init.headers.Authorization,/^Bearer COSY\./);assert.equal(init.headers['X-Model-Key'],'dfmodel');assert.equal(decode(init.body).model_config.key,'dfmodel');
    return new Response(wire(),{headers:{'content-type':'text/event-stream'}});
  }});
  assert.match(await (await fetch(CHAT_URL,{method:'POST',body:JSON.stringify(payload())})).text(),/OK/);
  assert.equal(tokens,1);assert.equal(requests,1);
});
test('metadata/unsupported controls fail before credentials; mismatched auth and HTTP errors never fall back',async()=>{
  let tokens=0,requests=0;
  const options={modelId:'dfmodel',legacyModel:entry,getToken:()=>{tokens++;return credential.accessToken;},getLegacyCredential:()=>credential,fetchImpl:async()=>{requests++;return new Response('PRIVATE_ERROR',{status:503});}};
  const call=(opts,body=payload())=>createQoderFetch(opts)(CHAT_URL,{method:'POST',body:JSON.stringify(body)});
  await assert.rejects(call({...options,legacyModel:undefined}),/legacy_model_metadata_required/);
  await assert.rejects(call(options,{...payload(),top_p:0.5}),/legacy_request_field_unsupported/);assert.equal(tokens,0);
  await assert.rejects(call({...options,getLegacyCredential:()=>({...credential,accessToken:'different'})}),/legacy_auth_unavailable/);assert.equal(requests,0);
  await assert.rejects(call(options),/http_503/);assert.equal(requests,1);
});
