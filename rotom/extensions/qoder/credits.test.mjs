import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {creditFields,createCreditCollector,creditSummary,normalizeQuota,fetchQuota,CREDIT_ENTRY,QUOTA_URL} from './credits.mjs';
import {createQoderFetch,CHAT_URL} from './transport.mjs';
import {installSessionPolicy,installQoderExtension,BINDING_TYPE} from './session-policy.mjs';
const uid='fixture-user',fingerprint='a'.repeat(64),credential={uid,accessToken:'fixture-token',fingerprint};
const quota={user_id:uid,user_quota:{total:6000,used:500,remaining:5500,unit:'Credits'},org_resource_package:{cap:10000,used:300,remaining:9700,unit:'Credit'}};
const usage={prompt_tokens:1,completion_tokens:1,total_tokens:2,credits:0.25,original_credits:0.5,billable:true};
const frame=d=>`data: ${JSON.stringify(d)}\n\n`;
const wire=frame({choices:[{delta:{content:'ok'},finish_reason:null}]})+frame({choices:[{delta:{},finish_reason:'stop'}],usage})+'data: [DONE]\n\n';
const request={method:'POST',body:JSON.stringify({model:'lite',stream:true,messages:[]})};
const response=body=>new Response(body,{headers:{'content-type':'text/event-stream'}});
function setupPolicy(){
 const events=new Map(),commands=new Map(),entries=[],display=[],status=new Map();let sessionId=randomUUID();
 const ctx={hasUI:true,model:{provider:'qoder-experimental'},sessionManager:{getEntries:()=>entries,getSessionId:()=>sessionId},ui:{setStatus:(k,v)=>status.set(k,v),notify:(content,level)=>display.push({content,level})},modelRegistry:{find:()=>({provider:'qoder-experimental',id:'lite'}),getApiKeyAndHeaders:async()=>({ok:true,apiKey:'fixture'}),refresh:async()=>({aborted:false,errors:new Map()})}};
 const pi={on:(k,f)=>{const list=events.get(k)??[];list.push(f);events.set(k,list);},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),registerProvider:()=>{},registerCommand:(k,c)=>commands.set(k,c),sendMessage:m=>display.push(m)};
 return{pi,ctx,entries,display,status,commands,emit:async(k,e={},c=ctx)=>{let result;for(const f of events.get(k)??[])result=await f(e,c);return result;},switchId:()=>{sessionId=randomUUID();}};
}
test('Credit fields are allowlisted and malformed values remain unknown',()=>{
 assert.deepEqual(creditFields({...usage,secret:'never expose'}),{credits:.25,original_credits:.5,billable:true});
 for(const value of [undefined,null,-1,Infinity,'0',false]){
  const c=createCreditCollector();c.observe({credits:value,billable:true});assert.equal(c.finish('complete').status,'unknown');
 }
 for(const value of [{},{billable:false},{credits:0}]){const c=createCreditCollector();c.observe(value);assert.equal(c.finish('complete').status,'unknown');}
 const c=createCreditCollector();c.observe({credits:0,billable:false});assert.deepEqual(c.finish('complete'),{status:'reported',outcome:'complete',credits:0,billable:false});
});
test('latest cumulative meter is not summed; malformed and incomplete streams are not known debit',()=>{
 const c=createCreditCollector();c.observe({credits:.1,billable:true});c.observe({credits:.3,original_credits:.6});assert.equal(c.finish('complete').credits,.3);assert.equal(c.finish('error').status,'unknown');
 c.observe({credits:'bad'});c.observe({credits:.4});assert.equal(c.finish('complete').status,'unknown');
});
test('credit aggregation is partial, deduplicated, and excludes inherited session spending and unbillable amounts',()=>{
 const entry=(requestId,more={})=>({type:'custom',customType:CREDIT_ENTRY,data:{version:1,sessionId:'current',modelId:'lite',requestId,status:'reported',outcome:'complete',billable:true,credits:.25,...more}});
 assert.deepEqual(creditSummary([entry('a'),entry('a'),entry('b',{sessionId:'parent'}),entry('c',{status:'unknown'}),entry('d',{billable:false,credits:2})],'current'),{credits:.25,reported:2,unknown:1});
 assert.equal(creditSummary([],'current').credits,null);
});
test('conflicting duplicate observations and overflowing totals are not a known subtotal',()=>{
 const e=(requestId,credits)=>({type:'custom',customType:CREDIT_ENTRY,data:{version:1,sessionId:'s',requestId,modelId:'lite',status:'reported',outcome:'complete',billable:true,credits}});
 assert.deepEqual(creditSummary([e('a',1),e('a',2)],'s'),{credits:null,reported:0,unknown:1});
 assert.deepEqual(creditSummary([e('a',Number.MAX_VALUE),e('b',Number.MAX_VALUE)],'s'),{credits:null,reported:2,unknown:0});
});
test('malformed optional entries never serialize arbitrary nested data or become metered',()=>{
 const cycle={};cycle.self=cycle;const e={type:'custom',customType:CREDIT_ENTRY,data:{version:1,sessionId:'s',requestId:'a',modelId:'lite',status:'reported',outcome:'complete',credits:cycle,billable:true}};
 assert.deepEqual(creditSummary([null,e,e],'s'),{credits:null,reported:0,unknown:1});
 assert.deepEqual(creditSummary([{...e,data:{...e.data,credits:1,modelId:cycle}}],'s'),{credits:null,reported:0,unknown:1});
});
test('quota identity, numeric types and units are explicit; no inferred balance arithmetic',()=>{
 const q=normalizeQuota(quota,credential);assert.equal(q.pools.shared.total,10000);assert.equal(q.pools.plan.remaining,5500);assert.equal(q.pools.addon,null);
 assert.throws(()=>normalizeQuota({...quota,user_id:'wrong'},credential),{code:'quota_identity_mismatch'});assert.throws(()=>normalizeQuota({},{}),{code:'quota_identity_mismatch'});
 assert.throws(()=>normalizeQuota({user_id:uid},credential),{code:'quota_schema_unavailable'});
 const p=normalizeQuota({user_id:uid,userQuota:{cap:4,used:1,unit:'USD',remaining:'3'}},credential).pools.plan;assert.equal(p.remaining,null);assert.equal(p.unit,'unknown');
});
test('quota uses one fixed read-only request and strips unrelated fields',async()=>{
 let calls=0;const result=await fetchQuota(credential,{fetchImpl:async(url,init)=>{calls++;assert.equal(url,QUOTA_URL);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');return Response.json({...quota,secret:'not returned'});}});
 assert.equal(calls,1);assert(!JSON.stringify(result).includes('secret'));assert(!JSON.stringify(result).includes(uid));
});
test('quota rejects oversized, malformed, mismatched and HTTP error responses without retries or bodies',async()=>{
 for(const response of [new Response('x'.repeat(65537)),new Response('private malformed body'),Response.json({...quota,user_id:'other'}),new Response('private upstream error',{status:403})]){
  let calls=0;await assert.rejects(fetchQuota(credential,{fetchImpl:async()=>{calls++;return response;}}),e=>/^Qoder: quota_/.test(e.message)&&!e.message.includes('private'));assert.equal(calls,1);
 }
});
test('quota cancellation bounds an uncooperative fetch and never dispatches an already-aborted call',async()=>{
 const controller=new AbortController();let called=0;
 const pending=fetchQuota(credential,{signal:controller.signal,fetchImpl:()=>{called++;return new Promise(()=>{});}});controller.abort();await assert.rejects(pending,{code:'quota_unavailable'});assert.equal(called,1);
 await assert.rejects(fetchQuota(credential,{signal:controller.signal,fetchImpl:()=>{called++;}}),{code:'quota_unavailable'});assert.equal(called,1);
});
test('transport emits one sanitized Credit event only after successful full stream validation',async()=>{
 const seen=[],f=createQoderFetch({getToken:async()=>'fixture',fetchImpl:async()=>response(wire),onMetering:m=>seen.push(m)});
 const text=await(await f(CHAT_URL,request)).text();assert(text.endsWith('data: [DONE]\n\n'));assert(!text.includes('credits'));assert.equal(seen.length,1);assert.equal(seen[0].credits,.25);assert.equal(seen[0].status,'reported');assert(!JSON.stringify(seen).includes('fixture'));
});
test('DONE is withheld until EOF; delayed trailing errors cannot publish a known charge',async()=>{
 let upstream;const seen=[],source=new ReadableStream({start(c){upstream=c;c.enqueue(new TextEncoder().encode(wire));}});
 const f=createQoderFetch({getToken:async()=>'fixture',fetchImpl:async()=>response(source),onMetering:m=>seen.push(m)}),reader=(await f(CHAT_URL,request)).body.getReader();
 await reader.read();await reader.read();const pending=reader.read();assert.equal(seen.length,0);
 upstream.enqueue(new TextEncoder().encode(frame({error:{message:'private upstream error'}})));upstream.close();
 await assert.rejects(pending,{code:'data_after_done'});assert.equal(seen.length,1);assert.equal(seen[0].status,'unknown');assert.equal(seen[0].outcome,'error');
});
test('cancellation after usage but before EOF is unknown, not zero or reported',async()=>{
 const seen=[],source=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(wire));}});
 const f=createQoderFetch({getToken:async()=>'fixture',fetchImpl:async()=>response(source),onMetering:m=>seen.push(m)}),reader=(await f(CHAT_URL,request)).body.getReader();
 await reader.read();await reader.read();await reader.cancel();assert.equal(seen.length,1);assert.equal(seen[0].status,'unknown');assert.equal(seen[0].outcome,'aborted');
});
test('pre-dispatch failures create no meter event; dispatched HTTP failures are unknown; observer failure is optional',async()=>{
 let seen=0,dispatched=0;const f=createQoderFetch({getToken:async()=>{throw new Error('private credential error');},fetchImpl:()=>dispatched++,onMetering:()=>seen++});await assert.rejects(f(CHAT_URL,request));assert.equal(seen+dispatched,0);
 const bad=createQoderFetch({getToken:async()=>'fixture',fetchImpl:async()=>new Response('private',{status:403}),onMetering:m=>{seen++;assert.equal(m.status,'unknown');}});await assert.rejects(bad(CHAT_URL,request),{code:'http_403'});assert.equal(seen,1);
 const optional=createQoderFetch({getToken:async()=>'fixture',fetchImpl:async()=>response(wire),onMetering:()=>{throw new Error('optional');}});assert((await(await optional(CHAT_URL,request)).text()).includes('[DONE]'));
});
test('meter persistence is bound to original account/session and not copied to a switched session',async()=>{
 const s=setupPolicy(),p=installSessionPolicy(s.pi);await s.emit('session_start');p.captureBinding()(fingerprint);const record=p.captureMetering(),data={fingerprint,modelId:'lite',requestId:randomUUID(),status:'reported',outcome:'complete',credits:.2,billable:true,secret:'not persisted'};
 record(data);record(data);assert.equal(s.entries.filter(e=>e.customType===CREDIT_ENTRY).length,1);assert(!JSON.stringify(s.entries).includes('secret'));
 assert.equal(s.status.get('qoder-credit-usage'),undefined);assert.equal(s.status.get('qoder-experimental'),undefined);
 s.switchId();await s.emit('session_start',{}, {...s.ctx});record({...data,requestId:randomUUID()});assert.equal(s.entries.filter(e=>e.customType===CREDIT_ENTRY).length,1);assert.equal(s.status.get('qoder-credit-usage'),undefined);
});
test('reused context objects and in-place session changes invalidate old captures',async()=>{
 const s=setupPolicy(),p=installSessionPolicy(s.pi);await s.emit('session_start');p.captureBinding()(fingerprint);
 let valid=p.captureScope(),bind=p.captureBinding(),record=p.captureMetering();s.switchId();assert.equal(valid(),false);assert.throws(()=>bind(fingerprint),{code:'account_binding_stale'});record({fingerprint,modelId:'lite',requestId:randomUUID(),status:'reported',outcome:'complete',credits:1,billable:true});assert(!s.entries.some(e=>e.customType===CREDIT_ENTRY));
 await s.emit('session_start');valid=p.captureScope();await s.emit('session_before_tree');assert.equal(valid(),false);
});
async function extension(s,fetchImpl){return installQoderExtension(s.pi,{piAI:{createProvider:p=>p},getCredential:async()=>credential,authMode:'qodercli',fetchImpl});}
test('quota commands without a UI or active scope fail before auth and HTTP',async()=>{
 const s=setupPolicy();let auth=0;s.ctx.modelRegistry.getApiKeyAndHeaders=()=>{auth++;assert.fail('auth must not resolve');};await extension(s,()=>assert.fail('HTTP must not dispatch'));
 const command=s.commands.get('qoder-credits');await assert.rejects(command.handler('',s.ctx),{code:'quota_context_unavailable'});s.ctx.hasUI=false;await assert.rejects(command.handler('',s.ctx),{code:'quota_ui_unavailable'});assert.equal(auth,0);
});
test('quota command only notifies UI, never writes conversation or compaction history',async()=>{
 const s=setupPolicy();let requests=0;await extension(s,async(url)=>{requests++;assert.equal(url,QUOTA_URL);return Response.json(quota);});await s.emit('session_start');await s.commands.get('qoder-credits').handler('',s.ctx);
 assert.equal(requests,1);assert.equal(s.display.length,1);assert(s.display[0].content.includes('9700'));assert(!s.display[0].content.includes(uid));
 assert.equal(s.entries.length,0);assert.equal(s.display[0].level,'info');
});
test('quota command rejects corrupt binding before auth resolution, and account mismatch before HTTP',async()=>{
 const s=setupPolicy();let auth=0,requests=0;s.ctx.modelRegistry.getApiKeyAndHeaders=async()=>{auth++;return{ok:true,apiKey:'fixture'};};await extension(s,async()=>{requests++;return Response.json(quota);});await s.emit('session_start');
 s.entries.push({type:'custom',customType:BINDING_TYPE,data:{version:99,fingerprint}});await s.commands.get('qoder-credits').handler('',s.ctx);assert.equal(auth+requests,0);
 s.entries[0].data={version:1,fingerprint:'b'.repeat(64)};await s.commands.get('qoder-credits').handler('',s.ctx);assert.equal(auth,1);assert.equal(requests,0);
});
test('a delayed quota result cannot write into a newly selected session',async()=>{
 const s=setupPolicy();let release,entered;const ready=new Promise(r=>entered=r);await extension(s,()=>{entered();return new Promise(r=>release=r);});await s.emit('session_start');const pending=s.commands.get('qoder-credits').handler('',s.ctx);await ready;
 s.switchId();await s.emit('session_start',{}, {...s.ctx});release(Response.json(quota));await pending;assert.equal(s.display.length,0);
});
