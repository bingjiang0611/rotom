import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const productRoot = process.env.ROTOM_QODER_PROBE_PRODUCT_ROOT ?? resolve(import.meta.dirname, '../../rotom');
assert(isAbsolute(productRoot) && realpathSync(productRoot) === productRoot && lstatSync(productRoot).isDirectory());
const providerFile = join(productRoot, 'extensions/qoder/provider.mjs');
assert(lstatSync(providerFile).isFile() && realpathSync(providerFile) === providerFile);
const { createQoderProvider } = await import(pathToFileURL(providerFile).href);
import { CATALOG_URL } from '../../rotom/extensions/qoder/catalog-auth.mjs';
import { LEGACY_URL, LEGACY_MODEL_IDS } from '../../rotom/extensions/qoder/legacy.mjs';
import { CHAT_URL, reasoningDetailsToItem, REASONING_MODEL_IDS, OPAQUE_MODEL_IDS } from '../../rotom/extensions/qoder/transport.mjs';
import { readProbeCredential } from './probe-credential.mjs';
import { parseProbeFrames } from './reasoning-probe.mjs';

const [mode = '--offline', id = 'gmodel', discovery] = process.argv.slice(2), live = mode === '--live', catalogOnly = discovery === '--catalog-only', discover = discovery === '--discover' || catalogOnly;
const delayedTrailer=discovery==='--delayed-trailer',negativeTrailer=discovery==='--negative-trailer'||delayedTrailer;
const reasoning=REASONING_MODEL_IDS.includes(id),legacy=LEGACY_MODEL_IDS.includes(id),opaque=OPAQUE_MODEL_IDS.includes(id);
assert(process.argv.slice(2).length <= 3);assert(['--offline','--live'].includes(mode));assert(discovery === undefined || (discover && live) || (negativeTrailer && !live && (delayedTrailer || ['mmodel','smodel'].includes(id))));
const entry = process.env.ROTOM_PI;
assert(entry && isAbsolute(entry) && lstatSync(entry).isFile() && realpathSync(entry) === entry);
assert(process.execArgv.includes('--experimental-import-meta-resolve'));
const piAI = await import(import.meta.resolve('@earendil-works/pi-ai', pathToFileURL(entry).href));
const openAI = await import(import.meta.resolve('@earendil-works/pi-ai/api/openai-completions', pathToFileURL(entry).href));
const ledger = process.env.ROTOM_QODER_PROBE_LEDGER;
if (live) assert(ledger && process.execArgv.some(a => a.endsWith('live-budget.mjs')));
const count = () => live ? Number(readFileSync(ledger,'utf8')) : 0;
const digest = () => live ? createHash('sha256').update(readFileSync(process.env.ROTOM_QODER_PROBE_AUTH_FILE)).digest('hex') : '';
const before = count(), original = digest();
const machineId = randomUUID(), uid = 'synthetic', org = '';
const credential = live ? (await readProbeCredential()).oauthCredential : {
  type:'oauth',qoderAuthVersion:1,access:'fixture-access',refresh:'fixture-refresh',expires:Date.now()+3600000,refreshExpires:Date.now()+86400000,machineId,uid,org,
  fingerprint:createHmac('sha256',machineId).update(JSON.stringify(['rotom-qoder-browser-v1',uid,org])).digest('hex'),
};
const snapshot = discover ? undefined : live ? JSON.parse(readFileSync(process.env.ROTOM_QODER_PROBE_CATALOG_FILE,'utf8')).scenes.assistant : [{key:id,display_name:'Synthetic',source:'system',enable:true,format:'openai',max_input_tokens:200000,is_reasoning:true,is_vl:false}];
const nonce = randomUUID(), marker = `THINKING_TOOL_RESULT_${randomUUID()}`;
const tool = {name:'reasoning_probe',description:'Synthetic nonce check; no side effects. Returns a fresh result string to use verbatim, not an echo of the nonce.',parameters:piAI.Type.Object({nonce:piAI.Type.String()},{additionalProperties:false})};
let calls = 0, catalogReads = 0, replayObserved = false, expectedReplay, sessionDir;
const summary = {mode,model:id,pass:false,rounds:[],nativeMetering:[],catalogSource:discover?'live account directory':'injected directory snapshot (no directory network request)'};
const event = chunk => `data: ${JSON.stringify(chunk)}\n\n`;
const provider = await createQoderProvider({piAI,openAI,authMode:'browser',onMetering:({modelId,status,outcome,credits,billable,originalCredits})=>summary.nativeMetering.push({modelId,status,outcome,...credits===undefined?{}:{credits},...billable===undefined?{}:{billable},...originalCredits===undefined?{}:{originalCredits}}),onDiagnostic:data=>{summary.diagnostics??=[];if(summary.diagnostics.length<12)summary.diagnostics.push(data);},fetchImpl:async(url,init)=>{
  if(url===CATALOG_URL){catalogReads++;return discover?fetch(url,init):new Response(JSON.stringify({assistant:snapshot}));}
  assert.equal(url,legacy?LEGACY_URL:CHAT_URL);assert.equal(catalogOnly,false);calls++;
  let body;
  if(legacy){
    const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',custom='_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$';
    const shuffled=[...init.body].map(c=>{assert(custom.includes(c));return alphabet[custom.indexOf(c)];}).join(''),n=shuffled.length,a=Math.floor(n/3);
    body=JSON.parse(Buffer.from(shuffled.slice(n-a)+shuffled.slice(a,n-a)+shuffled.slice(0,a),'base64').toString('utf8'));
    assert.equal(body.model_config.key,id);assert.equal(init.headers['X-Model-Key'],id);assert.equal(body.model_config.source,'system');assert.equal(body.parameters.reasoning_effort,reasoning?'high':'none');assert(body.parameters.context_length<=32000&&body.parameters.max_tokens<=4096);assert.equal(body.tools.length,1);
  }else{body=JSON.parse(init.body);assert.equal(body.enable_thinking,reasoning);assert.equal(body.reasoning_effort,reasoning?undefined:'none');}
  if(calls===2) {
    replayObserved=reasoning?body.messages.some(m=>m.role==='assistant'&&(opaque?m.reasoning_item!==undefined:typeof m.reasoning_content==='string'&&m.reasoning_content.length>0)):body.messages.some(m=>m.role==='tool'&&m.content.includes(marker));
    if(opaque)assert.deepEqual(body.messages.find(m=>m.reasoning_item)?.reasoning_item,expectedReplay);
  }
  if(live){
    const response=await fetch(url,init);
    if(process.env.ROTOM_QODER_PROBE_METERING==='1'){
      // Maintenance-only bounded clone inspection. No raw body is persisted;
      // buffering here makes this probe unsuitable as streaming-latency evidence.
      const observation={round:calls,frames:[],parsed:false};summary.rawMetering??=[];summary.rawMetering.push(observation);
      try{
        let bytes=0;const chunks=[];for await(const c of response.clone().body){bytes+=c.length;assert(bytes<=1024*1024);chunks.push(c);}
        for(const frame of parseProbeFrames(Buffer.concat(chunks).toString('utf8'))){
          let d=frame.data;if(typeof d?.body==='string'){try{d=JSON.parse(d.body);}catch{continue;}}
          if(!d?.usage)continue;assert(observation.frames.length<32);const value={};
          for(const k of ['credits','original_credits'])if(k in d.usage)value[k]=typeof d.usage[k]==='number'&&Number.isFinite(d.usage[k])&&d.usage[k]>=0?d.usage[k]:'invalid';
          if('billable' in d.usage)value.billable=typeof d.usage.billable==='boolean'?d.usage.billable:'invalid';
          observation.frames.push(value);
        }observation.parsed=true;
      }catch{observation.parsed=false;}
    }
    return response;
  }
  if(calls===2)assert(replayObserved);
  const delta=calls===1?{tool_calls:[{index:0,id:'fixture_call',type:'function',function:{name:tool.name,arguments:JSON.stringify({nonce})}}]}:{content:marker};
  const chunk=(delta,finish_reason=null)=>({choices:[{index:0,delta,finish_reason}]});
  const emit=legacy?value=>event({statusCodeValue:200,body:JSON.stringify(value)}):event;
  const wire=(reasoning?emit(chunk({reasoning_content:'Synthetic reasoning.'})):'')+emit(chunk(delta))+(opaque?emit(chunk({reasoning_item:{id:'fixture-reasoning-id',encrypted_content:'fixture-encrypted-data',...id==='smodel'?{target_hash:'a'.repeat(64)}:{}}})):'')+emit(id==='ultimate'?{choices:[{index:0,finish_reason:calls===1?'tool_calls':'stop'}]}:chunk({},calls===1?(id==='smodel'?'function_call':'tool_calls'):'stop'))+emit({choices:[],usage:{prompt_tokens:30,completion_tokens:10,total_tokens:40,credits:.25,original_credits:.5,billable:true}})+(['mmodel','smodel'].includes(id)?event({firstTokenDuration:1,totalDuration:2,serverDuration:1}):'data: [DONE]\n\n')+(negativeTrailer&&!delayedTrailer?event({unexpected:'late fixture'}):'');
  let timer;const responseBody=delayedTrailer?new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(wire));timer=setTimeout(()=>{c.enqueue(new TextEncoder().encode(event({unexpected:'delayed fixture'})));c.close();},100);},cancel(){clearTimeout(timer);}}):wire;
  return new Response(responseBody,{headers:{'content-type':'text/event-stream'}});
}});
try{
  await provider.refreshModels({credential,allowNetwork:true,signal:new AbortController().signal,publish:async p=>{assert(!p.persist);p.update?.();return true;}});
  const model=provider.getModels().find(m=>m.id===id);assert(model);assert.equal(model.reasoning,reasoning);if(reasoning)assert.deepEqual(piAI.getSupportedThinkingLevels(model),['medium']);summary.thinkingLevels=piAI.getSupportedThinkingLevels(model);
  if(catalogOnly){
    assert.deepEqual(provider.filterModels([],credential),[]);assert.deepEqual(provider.filterModels([model],undefined),[]);
    summary.scope='catalog-only';summary.pass=true;
  }else{
  const options=await provider.auth.oauth.toAuth(credential);
  const context={systemPrompt:'Synthetic protocol test. Use the requested tool, then quote only its result.',messages:[{role:'user',content:`${reasoning&&id!=='ultimate'?'Compute 37*41+29 internally, then proceed. ':''}Call reasoning_probe exactly once with nonce ${nonce}. After its result, reply with exactly the returned text.`,timestamp:Date.now()}],tools:[tool]};
  async function run(){
    const events={};const stream=provider.streamSimple(model,context,{...options,...reasoning?{reasoning:'medium'}:{},maxTokens:1024,sessionId:nonce});
    for await(const e of stream)events[e.type]=(events[e.type]??0)+1;
    const result=await stream.result();summary.rounds.push({stopReason:result.stopReason,events,usage:{input:result.usage.input,output:result.usage.output,cacheRead:result.usage.cacheRead},...(result.errorMessage?{errorCode:result.errorMessage.match(/Qoder: ([a-z0-9_]+)/)?.[1]??'native_stream_error'}:{})});return result;
  }
  const first=await run();
  if(negativeTrailer){assert.equal(first.stopReason,'error');assert.match(first.errorMessage,/Qoder: data_after_done/);summary.expectedRejection='data_after_done';assert.equal(summary.nativeMetering.length,1);assert.equal(summary.nativeMetering[0].status,'unknown');summary.pass=true;}
  else {
  assert.equal(first.stopReason,'toolUse');
  const toolCalls=first.content.filter(c=>c.type==='toolCall');assert.equal(toolCalls.length,1);assert.equal(toolCalls[0].name,tool.name);assert.deepEqual(toolCalls[0].arguments,{nonce});
  if(opaque) {
    const block=first.content.find(c=>c.type==='thinking'&&c.thinkingSignature?.startsWith('['));assert(block);
    expectedReplay=reasoningDetailsToItem(JSON.parse(block.thinkingSignature),id);
  }else if(reasoning)assert(first.content.some(c=>c.type==='thinking'&&c.thinking.length>0&&c.thinkingSignature==='reasoning_content'));
  context.messages.push(first,{role:'toolResult',toolCallId:toolCalls[0].id,toolName:tool.name,content:[{type:'text',text:marker}],isError:false,timestamp:Date.now()});
  {
    const sdk=await import(import.meta.resolve('@earendil-works/pi-coding-agent',pathToFileURL(entry).href));
    sessionDir=realpathSync(mkdtempSync(join(tmpdir(),'rotom-qoder-opaque-resume-')));
    const manager=sdk.SessionManager.create(sessionDir,sessionDir);manager.appendModelChange(model.provider,model.id);
    for(const message of context.messages)manager.appendMessage(message);
    const restored=sdk.SessionManager.open(manager.getSessionFile(),sessionDir);context.messages=restored.buildSessionContext().messages;
    const saved=context.messages.find(m=>m.role==='assistant').content.find(c=>c.type==='thinking');
    if(opaque)assert.deepEqual(reasoningDetailsToItem(JSON.parse(saved.thinkingSignature),id),expectedReplay);
    else if(reasoning)assert.equal(saved.thinkingSignature,'reasoning_content');summary.diskResume=true;
  }
  const second=await run();assert.equal(second.stopReason,'stop');
  const answer=second.content.filter(c=>c.type==='text').map(c=>c.text).join('').trim();
  summary.answerExact=answer===marker;summary.answerContainsMarker=answer.includes(marker);summary.answerBytes=Buffer.byteLength(answer);
  assert.equal(answer,marker);
  assert(replayObserved);assert.equal(calls,2);assert.equal(catalogReads,1);assert.equal(summary.nativeMetering.length,2);
  if(!live)assert(summary.nativeMetering.every(m=>m.status==='reported'&&m.credits===.25&&m.billable===true));summary.pass=true;
  }
  }
}catch{summary.pass=false;process.exitCode=1;}
summary.requests=count()-before;summary.dispatches=calls;summary.catalogQueries=discover?catalogReads:0;summary.ledgerTotal=count();summary.credentialsUnchanged=original===digest();summary[opaque?'opaqueReasoningReplay':reasoning?'plainReasoningReplay':'toolResultReplay']=replayObserved;
if(live&&(summary.requests!==calls+(discover?catalogReads:0)||!summary.credentialsUnchanged)){summary.pass=false;process.exitCode=1;}
if(sessionDir)rmSync(sessionDir,{recursive:true,force:true});
console.log(JSON.stringify(summary,null,2));
