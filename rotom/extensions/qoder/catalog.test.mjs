import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { catalogHeaders, CATALOG_URL } from './catalog-auth.mjs';
import { parseCatalog, fetchCatalog } from './catalog.mjs';
import { createQoderProvider, MODELS } from './provider.mjs';
import { installQoderExtension } from './session-policy.mjs';
import { CHAT_URL, createQoderFetch, normalizeSSE } from './transport.mjs';

const credential = { accessToken:'fixture-secret',uid:'fixture-user',org:'fixture-org',machineId:'fixture-machine',fingerprint:'a'.repeat(64) };
const entry = (key='auto',patch={}) => ({key,display_name:'Server Display Name',source:'system',enable:true,format:'openai',max_input_tokens:1000000,is_vl:true,is_reasoning:true,...patch});
const body = (...entries) => ({assistant:entries});
const context = (patch={}) => ({allowNetwork:true,signal:new AbortController().signal,publish:async p=>{assert.equal(p.persist,undefined);p.update?.();return true;},...patch});
async function fixture(options={}) {
  let current=credential, reply=body(entry()), calls=0;
  const provider=await createQoderProvider({piAI:{createProvider:x=>x,lazyStream:(_m,fn)=>fn()},authMode:'qodercli',getCredential:async()=>current,fetchImpl:async(url,init)=>{
    calls++;assert.equal(init.redirect,'error');
    if(url===CATALOG_URL)return new Response(JSON.stringify(reply));
    assert.equal(url,CHAT_URL);return new Response('',{status:403});
  },...options});
  return {provider,setCredential:c=>current=c,setReply:r=>reply=r,calls:()=>calls};
}

test('COSY envelope uses the exact signed path, fresh randomness and no raw access token',()=>{
  const h=catalogHeaders(credential,{now:()=>1700000000000}), another=catalogHeaders(credential);
  const [payload,sig]=h.Authorization.slice('Bearer COSY.'.length).split('.');
  assert.equal(h['Cosy-Version'],'1.1.45');assert.equal(h['Cosy-Sigpath'],'/api/v2/model/list');assert.equal(h['Cosy-Date'],'1700000000');
  assert.equal(sig,createHash('md5').update(`${payload}\n${h['Cosy-Key']}\n1700000000\n\n/api/v2/model/list`).digest('hex'));
  assert.equal(Buffer.from(h['Cosy-Key'],'base64').length,128);assert.equal(h['Cosy-Bodylength'],'0');
  assert.equal(h['Cosy-Organization-Id'],credential.org);assert.notEqual(h.Authorization,another.Authorization);
  assert.doesNotMatch(JSON.stringify(h),/fixture-secret/);
});
for(const patch of [{uid:''},{accessToken:'bad\nsecret'},{machineId:''},{org:'bad\rorg'}])test('invalid catalog identity fails sanitized',()=>{
  assert.throws(()=>catalogHeaders({...credential,...patch}),/^QoderError: Qoder: catalog_identity_unavailable$/);
});
test('catalog uses exact assistant keys and separates reported capabilities from adapter limits',()=>{
  const list=parseCatalog(body(entry('qmodel'),entry('user-model',{source:'user'}),entry('future-model'),entry('lite',{enable:false})));
  assert.deepEqual(list.map(e=>e.id),['qmodel','future-model','lite']);assert.equal(list[0].name,'Server Display Name');
  assert.equal(list[0].contextWindow,32000);assert.equal(list[0].reportedContextWindow,1000000);
  assert.equal(list[0].reportedImages,true);assert.equal(list[1].reviewed,false);assert.equal(list[2].enabled,false);
  assert.throws(()=>parseCatalog({chat:[entry()]}),/catalog_invalid/);
});
for(const entries of [[entry(),entry()],[entry('Auto')],[entry('x',{display_name:'bad\u001b[2J'})],[entry('x',{max_input_tokens:Infinity})],[entry('x',{enable:'true'})]])test('malformed/duplicate catalog fails closed',()=>{
  assert.throws(()=>parseCatalog(body(...entries)),/catalog_invalid/);
});
test('absent max_input_tokens is optional and keeps a conservative window without rejecting the catalog',()=>{
  // Upstream now advertises capacity for some system entries via context_config
  // only, omitting max_input_tokens; that must not fail-close the whole catalog.
  const noLimit={key:'kmodel',display_name:'Kimi',source:'system',enable:true,format:'openai',is_vl:true,context_config:{'400K':{token_count:400000},'1M':{token_count:1000000}}};
  const list=parseCatalog(body(noLimit,entry('gmodel')));
  assert.deepEqual(list.map(e=>e.id),['kmodel','gmodel']);
  const km=list[0];assert.equal(km.reportedContextWindow,undefined);
  // kmodel is a reviewed direct (non-expanded) key: the adapter window stays 32K and the advertised selectors grant no extra capacity.
  assert.equal(km.contextWindow,32000);assert.deepEqual(km.reportedContexts,[400000,1000000]);
  // null is treated as absent; a present but out-of-range/non-integer value still fails closed.
  assert.equal(parseCatalog(body({...noLimit,max_input_tokens:null}))[0].reportedContextWindow,undefined);
  for(const bad of [100,0,-1,'1000',1e12])assert.throws(()=>parseCatalog(body({...noLimit,max_input_tokens:bad})),/catalog_invalid/);
});
test('catalog request is one-shot, bounded, fixed-origin and sanitized',async()=>{
  let calls=0;
  await assert.rejects(fetchCatalog(credential,{fetchImpl:async(url,init)=>{calls++;assert.equal(url,CATALOG_URL);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');return new Response('PRIVATE',{status:403});}}),/^QoderError: Qoder: catalog_http_403$/);
  assert.equal(calls,1);
  await assert.rejects(fetchCatalog(credential,{fetchImpl:async()=>new Response('PRIVATE')}),/catalog_encoding_unsupported/);
  await assert.rejects(fetchCatalog(credential,{fetchImpl:async()=>new Response('x'.repeat(512*1024+1))}),/catalog_oversized/);
});
test('catalog cancellation bounds non-cooperative transport and body',async()=>{
  await assert.rejects(fetchCatalog(credential,{timeoutMs:10,fetchImpl:()=>new Promise(()=>{})}),/aborted/);
  await assert.rejects(fetchCatalog(credential,{timeoutMs:10,fetchImpl:async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});}}))}),/aborted/);
});
test('registration/offline refresh do not fetch or restore account-independent stored models',async()=>{
  const f=await fixture();await f.provider.refreshModels(context({allowNetwork:false,stored:{models:[{id:'evil'}]}}));
  assert.deepEqual(f.provider.getModels().map(m=>m.id),['lite','performance','auto','qmodel','kmodel','gmodel','dmodel','ultimate','dfmodel','efficient','qmodel_38max','qfmodel','qmodel_latest','kmodel_latest','gfmodel','mmodel','smodel']);assert.deepEqual(f.provider.filterModels(f.provider.getModels()),MODELS);assert.equal(f.calls(),0);
});
test('availability filtering never reintroduces a model removed by the caller',async()=>{
  const f=await fixture();assert.deepEqual(f.provider.filterModels([]),[]);assert.deepEqual(f.provider.filterModels([MODELS[0]]),[MODELS[0]]);
  await f.provider.refreshModels(context());assert.deepEqual(f.provider.filterModels([]),[]);
});
test('dynamic catalog publication preserves conservative capabilities and hides disabled/unreviewed/custom routes',async()=>{
  const f=await fixture();f.setReply(body(entry('auto'),entry('gmodel'),entry('unreviewed_fixture'),entry('lite',{enable:false}),entry('qmodel',{format:'anthropic'})));
  await f.provider.refreshModels(context());
  assert.deepEqual(f.provider.getModels().map(m=>m.id),['auto','gmodel']);
  const m=f.provider.getModels()[1];assert.equal(m.reasoning,true);assert.equal(m.thinkingLevelMap.off,null);assert.equal(m.thinkingLevelMap.medium,'enabled');assert.deepEqual(m.input,['text']);assert.equal(m.maxTokens,4096);assert.equal(m.contextWindow,32000);
  assert.equal(f.provider.getCatalogStatus().length,5);
  await f.provider.refreshModels(context());assert.equal(f.calls(),1);
  await f.provider.refreshModels(context({force:true}));assert.equal(f.calls(),2);
});
test('failed/rejected/aborted publication cannot replace prior account catalog',async()=>{
  const f=await fixture();await f.provider.refreshModels(context({publish:async()=>false}));assert.deepEqual(f.provider.filterModels(f.provider.getModels()),MODELS);
  await f.provider.refreshModels(context());f.setReply(body(entry('gmodel')));
  await f.provider.refreshModels(context({force:true,publish:async()=>false}));assert.deepEqual(f.provider.getModels().map(m=>m.id),['auto']);
  f.setReply({assistant:'invalid'});await assert.rejects(f.provider.refreshModels(context({force:true})),/catalog_invalid/);assert.deepEqual(f.provider.getModels().map(m=>m.id),['auto']);
});
test('named stream requires fresh discovery and rejects changed account before model dispatch',async()=>{
  const f=await fixture();const model={...MODELS[0],id:'auto'};
  await assert.rejects(f.provider.api.streamSimple(model,{messages:[]},{}),/catalog_refresh_required/);assert.equal(f.calls(),0);
  await f.provider.refreshModels(context());f.setCredential({...credential,fingerprint:'b'.repeat(64)});
  await assert.rejects(f.provider.api.streamSimple(f.provider.getModels()[0],{messages:[]},{}),/catalog_account_mismatch/);assert.equal(f.calls(),1);
  await f.provider.auth.apiKey.resolve();assert.deepEqual(f.provider.filterModels(f.provider.getModels()),[]);
});
test('startup/explicit command use native provider-scoped refresh without binding or exposing errors',async()=>{
  const handlers=new Map(),commands=new Map(),notices=[];let calls=0,bindings=0;
  const pi={on:(name,fn)=>handlers.set(name,[...(handlers.get(name)??[]),fn]),registerProvider(){},registerCommand:(name,c)=>commands.set(name,c),appendEntry(){bindings++;}};
  await installQoderExtension(pi,{piAI:{createProvider:x=>x},authMode:'qodercli',getToken:async()=> 'fixture'});
  const ctx={hasUI:true,sessionManager:{getEntries:()=>[]},ui:{setStatus(){},notify:text=>notices.push(text)},modelRegistry:{refresh:async options=>{calls++;assert.deepEqual(options.providers,['qoder-experimental']);assert.equal(options.allowNetwork,true);return{aborted:false,errors:new Map()};}}};
  for(const handler of handlers.get('session_start'))await handler({},ctx);assert.equal(calls,1);assert.equal(bindings,0);
  await commands.get('qoder-models').handler('',ctx);assert.equal(calls,2);
  ctx.modelRegistry.refresh=async()=>{throw new Error('PRIVATE ERROR BODY');};await commands.get('qoder-models').handler('',ctx);assert.doesNotMatch(JSON.stringify(notices),/PRIVATE/);
});
test('model metadata overrides and unvalidated reasoning controls fail before credentials/network',async()=>{
  const f=await fixture();f.setReply(body(entry('gmodel')));await f.provider.refreshModels(context());const m=f.provider.getModels()[0];
  for(const patch of [{baseUrl:'https://example.invalid'},{reasoning:false},{contextWindow:1000000}])await assert.rejects(f.provider.api.streamSimple({...m,...patch},{messages:[]},{}),/model_scope_rejected/);
  await assert.rejects(f.provider.api.streamSimple(m,{messages:[]},{reasoning:'high'}),/reasoning_controls_not_validated/);assert.equal(f.calls(),1);
});
test('browser catalog is tied to validated OAuth identity and not a raw-token override',async()=>{
  const machineId=randomUUID(),uid='fixture',org='';
  const c={type:'oauth',qoderAuthVersion:1,access:'fixture',refresh:'fixture-refresh',expires:Date.now()+3600000,refreshExpires:Date.now()+86400000,machineId,uid,org,fingerprint:createHmac('sha256',machineId).update(JSON.stringify(['rotom-qoder-browser-v1',uid,org])).digest('hex')};
  const f=await fixture({authMode:'browser'});await f.provider.refreshModels(context({credential:c}));
  assert.deepEqual(f.provider.filterModels(f.provider.getModels(),c).map(m=>m.id),['auto']);
  assert.deepEqual(f.provider.filterModels(f.provider.getModels(),{...c,fingerprint:'b'.repeat(64)}),[]);
  await assert.rejects(f.provider.refreshModels(context({credential:{...c,access:'override',uid:'changed'}})),/oauth_credential_invalid/);assert.equal(f.calls(),1);
});
test('catalog expires without automatic fallback dispatch or network refresh',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await fixture();await f.provider.refreshModels(context());
  t.mock.timers.tick(3600001);assert.deepEqual(f.provider.filterModels(f.provider.getModels()),[]);
  await assert.rejects(f.provider.api.streamSimple(f.provider.getModels()[0],{messages:[]},{}),/catalog_refresh_required/);assert.equal(f.calls(),1);
});
test('catalog replacement while reading credentials blocks stale selection before dispatch',async()=>{
  let block=false,release;const f=await fixture({getCredential:async()=>{if(block){block=false;return new Promise(r=>release=r);}return credential;}});
  await f.provider.refreshModels(context());block=true;const pending=f.provider.api.streamSimple(f.provider.getModels()[0],{messages:[]},{});
  await new Promise(setImmediate);assert(release);await f.provider.refreshModels(context({force:true}));release(credential);
  await assert.rejects(pending,/catalog_changed_select_again/);assert.equal(f.calls(),2);
});
test('post-hook custom routes and alternate thinking formats never reach credentials/network',async()=>{
  let reads=0;const fetch=createQoderFetch({modelId:'gmodel',getToken:async()=>{reads++;return 'fixture';}});
  for(const key of ['custom_model','model_config','provider','patches','thinking','reasoning','chat_template_kwargs','chat_template_args'])await assert.rejects(fetch(CHAT_URL,{method:'POST',body:JSON.stringify({model:'gmodel',stream:true,messages:[],[key]:{url:'https://example.invalid'}})}),/request_scope_rejected/);
  assert.equal(reads,0);
});
test('only plain assistant reasoning_content can be replayed on enabled routes',async()=>{
  let calls=0;const fetch=createQoderFetch({modelId:'gmodel',getToken:async()=>credential.accessToken,fetchImpl:async()=>{calls++;return new Response('',{status:403});}});
  const run=patch=>fetch(CHAT_URL,{method:'POST',body:JSON.stringify({model:'gmodel',messages:[],stream:true,...patch})});
  await assert.rejects(run({messages:[{role:'assistant',reasoning_content:'plain',content:'text'}]}),/http_403/);assert.equal(calls,1);
  for(const patch of [{enable_thinking:false},{reasoning_effort:'high'},{messages:[{role:'user',reasoning_content:'not assistant'}]},{messages:[{role:'assistant',reasoning_item:{opaque:'PRIVATE'}}]}])await assert.rejects(run(patch));
  assert.equal(calls,1);
});
test('plain reasoning SSE is opt-in; opaque and alternate fields remain rejected',async()=>{
  const wire=d=>`data: ${JSON.stringify({choices:[{delta:d,finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`;
  for(const d of [{reasoning_item:{secret:1}},{reasoning_details:[]},{reasoning:'alternate'}])await assert.rejects(async()=>{for await(const _ of normalizeSSE(new Response(wire(d)).body,{allowReasoning:true})){};});
  let output='';for await(const f of normalizeSSE(new Response(wire({reasoning_content:'plain'})).body,{allowReasoning:true}))output+=f;
  assert.match(output,/plain/);
});
