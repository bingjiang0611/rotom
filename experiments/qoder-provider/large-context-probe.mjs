// Explicit research wire, NOT a product capability switch. Synthetic random
// records, disjoint multi-position lookups, tool roundtrip and native disk replay.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,realpathSync,lstatSync,chmodSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {CATALOG_URL} from '../../rotom/extensions/qoder/catalog-auth.mjs';
import {LEGACY_URL} from '../../rotom/extensions/qoder/legacy.mjs';
import {MODEL} from '../../rotom/extensions/qoder/provider.mjs';
import {CHAT_URL,normalizeSSE,reasoningDetailsToItem} from '../../rotom/extensions/qoder/transport.mjs';
import {readProbeCredential} from './probe-credential.mjs';
import {probeWire,decodeProbeBody} from './probe-wire.mjs';
import {observeStream} from './stream-shape.mjs';
const [mode='--offline',id='ultimate',rowsArg='1024',minimumArg='0',selectorArg='400000',layout='single']=process.argv.slice(2);
const live=mode==='--live',rows=Number(rowsArg),minimum=Number(minimumArg),selector=Number(selectorArg);assert([400000,1000000].includes(selector));
assert(['--offline','--live'].includes(mode)&&['ultimate','kmodel_latest','dfmodel'].includes(id)&&['single','split'].includes(layout));
assert(Number.isSafeInteger(rows)&&rows>=64&&rows<=30000&&Number.isSafeInteger(minimum)&&minimum>=0&&minimum<=320000);
const entry=process.env.ROTOM_PI;assert(entry&&isAbsolute(entry)&&lstatSync(entry).isFile()&&realpathSync(entry)===entry);
assert(process.execArgv.includes('--experimental-import-meta-resolve'));
const entryURL=pathToFileURL(entry).href;
const ai=await import(import.meta.resolve('@earendil-works/pi-ai',entryURL));
const openAI=await import(import.meta.resolve('@earendil-works/pi-ai/api/openai-completions',entryURL));
const sdk=await import(import.meta.resolve('@earendil-works/pi-coding-agent',entryURL));
const ledger=process.env.ROTOM_QODER_PROBE_LEDGER,count=()=>live?Number(readFileSync(ledger,'utf8')):0,before=count();
if(live)assert(process.execArgv.some(x=>x.endsWith('live-budget.mjs')));
const hash=()=>live?createHash('sha256').update(readFileSync(process.env.ROTOM_QODER_PROBE_AUTH_FILE)).digest('hex'):null,authBefore=hash();
const catalog=live?JSON.parse(readFileSync(process.env.ROTOM_QODER_PROBE_CATALOG_FILE,'utf8')).scenes.assistant:[];
const row=live?catalog.find(e=>e.key===id):{key:id,display_name:'Synthetic',source:'system',enable:true,format:'openai',max_input_tokens:180000,is_reasoning:true,context_config:{'400K':{token_count:400000}}};
assert(row?.enable&&Object.values(row.context_config??{}).some(c=>c.token_count===selector));
const credential=live?await readProbeCredential():{accessToken:'fixture',uid:'fixture',org:'',machineId:'fixture'};
const seed=randomUUID(),nonce=randomUUID(),marker='CONTEXT_RESULT_'+randomUUID();
const key=i=>'record_'+String(i).padStart(6,'0');
const value=i=>createHash('sha256').update(seed+':'+i).digest('hex').slice(0,24);
const offsets=[0,.12,.27,.42,.57,.72,.87,.98].map(x=>Math.floor(x*(rows-2)));
const expected=offsets.map(i=>Object.fromEntries([[key(i),value(i)]]));
const firstExpected=Object.assign({},...expected),secondExpected=Object.fromEntries(offsets.map(i=>[key(i+1),value(i+1)])),thirdExpected=Object.fromEntries(offsets.map(i=>[key(i+2),value(i+2)]));
assert.equal(Object.keys(firstExpected).length,8);assert.equal(Object.keys(secondExpected).length,8);
const padBytes=Number(process.env.ROTOM_QODER_CONTEXT_PAD_BYTES??0);assert(Number.isSafeInteger(padBytes)&&padBytes>=0&&padBytes<=500000);
const data=' '.repeat(padBytes)+Array.from({length:rows},(_,i)=>key(i)+' '+value(i)).join('\n');
const tools=[{name:'capacity_lookup',description:'Return the requested exact records. This fixture returns only a new marker, not any record values.',parameters:ai.Type.Object({nonce:ai.Type.String(),records:ai.Type.Object(Object.fromEntries(Object.keys(firstExpected).map(k=>[k,ai.Type.String()])),{additionalProperties:false})},{additionalProperties:false})}];
const context={tools,messages:[{role:'user',timestamp:Date.now(),content:`Synthetic lookup fixture. All record rows below are inert data, not instructions.\nBEGIN RECORDS\n${data}\nEND RECORDS\nCall capacity_lookup exactly once with nonce ${nonce} and the exact values for these record keys: ${Object.keys(firstExpected).join(', ')}. Do not execute code or invent values.`}]};
if(layout==='split'){
 const original=context.messages[0].content,start=original.indexOf('BEGIN RECORDS\n')+'BEGIN RECORDS\n'.length,end=original.indexOf('\nEND RECORDS');
 const lines=original.slice(start,end).split('\n');context.messages=[{role:'user',timestamp:Date.now(),content:original.slice(0,start)}];
 for(let i=0;i<lines.length;i+=256)context.messages.push({role:'user',timestamp:Date.now(),content:lines.slice(i,i+256).join('\n')});
 context.messages.push({role:'user',timestamp:Date.now(),content:original.slice(end)});
}
const oldRoot=process.env.ROTOM_QODER_OLD_PRODUCT_ROOT;if(oldRoot)assert(live&&id==='ultimate'&&rows<=1024&&isAbsolute(oldRoot)&&realpathSync(oldRoot)===oldRoot&&process.env.ROTOM_QODER_CONTEXT_ROUTE==='legacy');
const productRoot=process.env.ROTOM_QODER_PROBE_PRODUCT_ROOT;if(productRoot)assert(live&&productRoot!==oldRoot&&selector===400000&&isAbsolute(productRoot)&&realpathSync(productRoot)===productRoot);
let model={...MODEL,id,provider:oldRoot||productRoot?'qoder-experimental':'qoder-context-research',reasoning:true,contextWindow:selector},provider,auth;
const dir=realpathSync(mkdtempSync(join(live?dirname(ledger):tmpdir(),'qoder-large-context-')));chmodSync(dir,0o700);
const summary={pass:false,scope:'maintenance native SDK, not product capacity',directory:dir,mode,id,rows,layout,padBytes,minimumInputTokens:minimum,selector,reportedBaseLimit:row.max_input_tokens,sourceBytes:Buffer.byteLength(data),piEntry:entry,piEntrySha256:createHash('sha256').update(readFileSync(entry)).digest('hex'),rounds:[],wire:[],diagnostics:{}};
const save=()=>writeFileSync(join(dir,'result.json'),JSON.stringify(summary,null,2),{mode:0o600});save();console.error('Evidence: '+dir);
let calls=0,dispatches=0,catalogDispatches=0,opaque;const opaqueItems=new Map();
const event=(d,legacy)=>`data: ${JSON.stringify(legacy?{statusCodeValue:200,body:JSON.stringify(d)}:d)}\n\n`;
function checkMessages(body){
 if(calls>=2){assert(body.messages.some(m=>m.role==='tool'&&m.content.includes(marker)));summary.toolResultWireReplay=true;if(opaque){for(const previous of opaqueItems.values())assert(body.messages.some(m=>m.role==='assistant'&&JSON.stringify(m.reasoning_item)===JSON.stringify(previous)));summary.opaqueWireReplay=true;summary.opaqueReplayRequests=(summary.opaqueReplayRequests??0)+1;summary.opaqueItemsPreserved=opaqueItems.size;}}
}
async function fetchWire(url,init){
 assert.equal(String(url),CHAT_URL);assert(calls<3);calls++;
 const body=JSON.parse(init.body);
 for(const m of body.messages)if(m.reasoning_details){m.reasoning_item=reasoningDetailsToItem(m.reasoning_details,id);delete m.reasoning_details;}
 checkMessages(body);
 const route=process.env.ROTOM_QODER_CONTEXT_ROUTE??'current';assert(['current','legacy'].includes(route));
 const wire=probeWire({id,entry:row,credential,messages:body.messages,tools:body.tools,contextLength:selector,effort:'low',maxTokens:4096,route});
 const gzip=process.env.ROTOM_QODER_CONTEXT_GZIP==='1';assert(!gzip||wire.route==='direct');
 const transmitted=gzip?gzipSync(wire.body):wire.body;
 const shape={route:wire.route,bytes:Buffer.byteLength(wire.body),gzip,transmittedBytes:Buffer.byteLength(transmitted)};summary.wire.push(shape);let response;
 if(live){dispatches++;const start=Date.now();response=await fetch(wire.url,{method:'POST',headers:{...wire.headers,...gzip?{'Content-Encoding':'gzip'}:{}},body:transmitted,redirect:'error',signal:AbortSignal.timeout(300000)});shape.httpStatus=response.status;if(!response.ok){const reader=response.body?.getReader(),chunks=[];let n=0;try{if(reader)for(;;){const b=await reader.read();if(b.done)break;n+=b.value.length;if(n>16384)break;chunks.push(b.value);}}finally{void reader?.cancel().catch(()=>{});reader?.releaseLock();}const text=Buffer.concat(chunks).toString('utf8').toLowerCase();shape.httpFailure={boundedBytes:n,contextLimit:/context.{0,30}(limit|exceed|long)|too many tokens|prompt.{0,30}(long|limit)/.test(text),requestSize:/payload.{0,30}(large|size)|body.{0,30}(large|size)|entity too large/.test(text),internal:/internal server error/.test(text),rateLimited:/rate limit|quota/.test(text),unsupported:/unsupported|not support/.test(text)};throw new Error('research_http_'+response.status);}Object.assign(shape,await observeStream(response));shape.responseBufferedMs=Date.now()-start;}
 else{const delta=calls===1?{tool_calls:[{index:0,id:'capacity-call',type:'function',function:{name:'capacity_lookup',arguments:JSON.stringify({nonce,records:firstExpected})}}]}:{content:JSON.stringify({marker,records:calls===2?secondExpected:thirdExpected})};if(id==='ultimate')delta.reasoning_item={id:'opaque_fixture_'+calls,encrypted_content:'fixture-opaque',...wire.route==='legacy'?{target_hash:'t'.repeat(64)}:{}};response=new Response(event({choices:[{delta,finish_reason:null}]},wire.route==='legacy')+event({choices:[{delta:{},finish_reason:calls===1?'tool_calls':'stop'}],usage:{prompt_tokens:300000,completion_tokens:100,total_tokens:300100}},wire.route==='legacy')+'data: [DONE]\n\n');}
 const frames=[];let size=0;
 try{for await(const frame of normalizeSSE(response.body,{allowReasoning:true,allowOpaqueReasoning:id==='ultimate',opaqueModelId:id,allowLegacyEnvelope:wire.route==='legacy',allowLegacyMetricsDone:wire.route==='legacy',toolNames:['capacity_lookup'],onDiagnostic:d=>{if(['frame_continuation','usage_continuation','field_prefix_continuation'].includes(d.code))summary.diagnostics[d.code]=(summary.diagnostics[d.code]??0)+1;}})){
  size+=Buffer.byteLength(frame);assert(size<=2*1024*1024);frames.push(frame);
  if(id==='ultimate'&&frame!=='data: [DONE]\n\n'){const details=JSON.parse(frame.slice(6)).choices?.find(c=>c.delta?.reasoning_details)?.delta.reasoning_details;if(details){opaque=reasoningDetailsToItem(details,id);opaqueItems.set(opaque.id,opaque);}}
 }}catch(e){summary.protocolError=/^[a-z0-9_]+$/.test(e.code??'')?e.code:'normalizer_failed';throw e;}
 return new Response(frames.join(''),{headers:{'content-type':'text/event-stream'}});
}
const options={apiKey:'research-resolves-auth-at-dispatch',maxTokens:4096,maxRetries:0,fetch:fetchWire};
function recordRound(m){for(const b of m.content)if(b.type==='thinking'&&b.thinkingSignature?.startsWith('[')){opaque=reasoningDetailsToItem(JSON.parse(b.thinkingSignature),id);opaqueItems.set(opaque.id,opaque);}const u=m.usage,input=u.input+u.cacheRead+u.cacheWrite;summary.rounds.push({stopReason:m.stopReason,inputTokens:input,outputTokens:u.output});if(m.errorMessage)summary.protocolError=m.errorMessage.match(/Qoder: ([a-z0-9_]+)/)?.[1]??'native_stream_error';return input;}
const stream=()=>productRoot?provider.streamSimple(model,context,{...auth,reasoning:'low',maxTokens:4096}):openAI.stream(model,context,options);
try{
 if(productRoot){
  summary.scope='native SDK with actual product provider';summary.productRoot=productRoot;summary.productDigests=Object.fromEntries(['catalog.mjs','legacy.mjs','provider.mjs','transport.mjs'].map(f=>[f,createHash('sha256').update(readFileSync(join(productRoot,'extensions/qoder',f))).digest('hex')]));
  const factory=(await import(pathToFileURL(join(productRoot,'extensions/qoder/provider.mjs')).href)).createQoderProvider;
  provider=await factory({piAI:ai,openAI,authMode:'browser',fetchImpl:async(url,init)=>{
   if(url===CATALOG_URL){catalogDispatches++;return fetch(url,init);}assert.equal(url,LEGACY_URL);assert(calls<3);calls++;const body=decodeProbeBody(init.body);assert.equal(body.model_config.key,id);assert.equal(body.parameters.context_length,selector);assert.equal(body.parameters.max_tokens,4096);checkMessages(body);dispatches++;const response=await fetch(url,init);summary.wire.push({round:calls,route:'product-cosy',status:response.status,requestedMaxTokens:body.parameters.max_tokens,bytes:Buffer.byteLength(init.body),...await observeStream(response)});return response;
  }});
  await provider.refreshModels({credential:credential.oauthCredential,allowNetwork:true,signal:AbortSignal.timeout(20000),publish:async p=>{p.update?.();return true;}});auth=await provider.auth.oauth.toAuth(credential.oauthCredential);model=provider.getModels().find(m=>m.id===id);assert.equal(model.contextWindow,272000);summary.declaredContext=model.contextWindow;
  // Product runs must stay under window-8192 or Pi legitimately starves the answer.
  assert(minimum<=model.contextWindow-8192,'product_minimum_exceeds_answer_budget');
 }
 let first;
 if(oldRoot){
  summary.baselineProductRoot=oldRoot;summary.baselineTransportSha256=createHash('sha256').update(readFileSync(join(oldRoot,'extensions/qoder/transport.mjs'))).digest('hex');
  const {createQoderProvider}=await import(pathToFileURL(join(oldRoot,'extensions/qoder/provider.mjs')).href);
  const provider=await createQoderProvider({piAI:ai,openAI,authMode:'browser',fetchImpl:async(url,init)=>{
   if(url===CATALOG_URL){catalogDispatches++;return fetch(url,init);}assert.equal(url,CHAT_URL);assert.equal(calls,0);calls++;dispatches++;const response=await fetch(url,init);summary.wire.push({route:'installed-baseline-direct',bytes:Buffer.byteLength(init.body),...await observeStream(response)});return response;
  }});
  await provider.refreshModels({credential:credential.oauthCredential,allowNetwork:true,signal:AbortSignal.timeout(20000),publish:async p=>{p.update?.();return true;}});
  const auth=await provider.auth.oauth.toAuth(credential.oauthCredential),oldModel=provider.getModels().find(m=>m.id===id);assert.equal(oldModel.contextWindow,32000);
  first=await provider.streamSimple(oldModel,context,{apiKey:auth.apiKey,reasoning:'high',maxTokens:4096}).result();
  for(const b of first.content)if(b.type==='thinking'&&b.thinkingSignature?.startsWith('[')){const details=JSON.parse(b.thinkingSignature);if(details[0]?.format==='rotom-qoder-ultimate-v1'){opaque=reasoningDetailsToItem(details,id);opaqueItems.set(opaque.id,opaque);}}
  assert(opaque,'baseline_opaque_not_observed');summary.baselineOpaqueObserved=true;
 }else first=await stream().result();
 const firstInput=recordRound(first);assert.equal(first.stopReason,'toolUse');
 const toolCalls=first.content.filter(b=>b.type==='toolCall');assert.equal(toolCalls.length,1);assert.equal(toolCalls[0].name,'capacity_lookup');assert.deepEqual(toolCalls[0].arguments,{nonce,records:firstExpected});summary.firstLookupExact=true;
 assert(firstInput>=minimum&&firstInput<selector-4096,'input_coverage_or_headroom');
 const tool={role:'toolResult',toolCallId:toolCalls[0].id,toolName:'capacity_lookup',isError:false,timestamp:Date.now(),content:[{type:'text',text:marker}]};
 const manager=sdk.SessionManager.create(dir,dir);for(const m of [...context.messages,first,tool])manager.appendMessage(m);
 context.messages=sdk.SessionManager.open(manager.getSessionFile(),dir).buildSessionContext().messages;
 context.messages.push({role:'user',timestamp:Date.now(),content:`Read DIFFERENT records from the original data. Reply only JSON {"marker":"the tool marker","records":{...}} for keys ${Object.keys(secondExpected).join(', ')}. Do not call a tool. Use exact values, not the previous lookup.`});
 const second=await stream().result();const secondInput=recordRound(second);assert.equal(second.stopReason,'stop');assert(secondInput>=minimum&&secondInput<selector-4096);
 let text=second.content.filter(b=>b.type==='text').map(b=>b.text).join('').trim();if(/^```(?:json)?\s*[\s\S]*\s*```$/.test(text))text=text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
 assert.deepEqual(JSON.parse(text),{marker,records:secondExpected});summary.secondLookupExact=true;summary.diskResume=true;
 if(id==='ultimate'&&opaque){
  const resumed=sdk.SessionManager.open(manager.getSessionFile(),dir);resumed.appendMessage(context.messages.at(-1));resumed.appendMessage(second);
  context.messages=sdk.SessionManager.open(manager.getSessionFile(),dir).buildSessionContext().messages;
  context.messages.push({role:'user',timestamp:Date.now(),content:`One last exact lookup from the original data, without tools. Reply only JSON {"marker":"the tool marker","records":{...}} for keys ${Object.keys(thirdExpected).join(', ')}.`});
  const third=await stream().result();const thirdInput=recordRound(third);assert.equal(third.stopReason,'stop');assert(thirdInput>=minimum&&thirdInput<selector-4096);
  let answer=third.content.filter(b=>b.type==='text').map(b=>b.text).join('').trim();if(/^```(?:json)?\s*[\s\S]*\s*```$/.test(answer))answer=answer.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
  resumed.appendMessage(context.messages.at(-1));resumed.appendMessage(third);
  const parsed=JSON.parse(answer);summary.thirdMarkerExact=parsed?.marker===marker;summary.thirdValueMismatches=Object.entries(thirdExpected).filter(([k,v])=>parsed?.records?.[k]!==v).length;
  assert.deepEqual(parsed,{marker,records:thirdExpected});summary.thirdLookupExact=true;summary.secondDiskResume=true;
 }
 summary.opaqueObserved=Boolean(opaque);if(opaque)assert(summary.opaqueWireReplay);summary.pass=true;
}catch(e){summary.errorCode=e.code==='ERR_ASSERTION'?'assertion_failed':/^[a-z0-9_]+$/.test(e.code??e.message??'')?e.code??e.message:'large_context_failed';summary.errorLine=e.stack?.match(/large-context-probe\.mjs:(\d+):/)?.[1];process.exitCode=1;}
summary.requests=count()-before;summary.modelRequests=dispatches;summary.catalogRequests=catalogDispatches;summary.ledgerTotal=count();summary.credentialsUnchanged=authBefore===hash();if(summary.requests!==dispatches+catalogDispatches||!summary.credentialsUnchanged){summary.pass=false;process.exitCode=1;}save();console.log(JSON.stringify(summary,null,2));
