// Explicit research adapter by default; --product uses the real provider path.
// Native serializer/parser and disk replay; two synthetic calls per independent case.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,realpathSync,chmodSync} from 'node:fs';
import {join,dirname,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {readProbeCredential} from './probe-credential.mjs';
import {probeWire} from './probe-wire.mjs';
import {observeStream} from './stream-shape.mjs';
import {CATALOG_URL,catalogHeaders} from '../../rotom/extensions/qoder/catalog-auth.mjs';
import {MODEL} from '../../rotom/extensions/qoder/provider.mjs';
import {normalizeSSE,OPAQUE_MODEL_IDS,reasoningDetailsToItem} from '../../rotom/extensions/qoder/transport.mjs';
import {LEGACY_MODEL_IDS,LEGACY_URL} from '../../rotom/extensions/qoder/legacy.mjs';
import {decodeProbeBody} from './probe-wire.mjs';
const [id,selection,variant]=process.argv.slice(2),product=variant==='--product';assert((variant===undefined||product)&&process.argv.length<=5&&process.argv.length>=3&&['ultimate','smodel','qmodel_38max','qfmodel','kmodel_latest','gmodel','gfmodel','dmodel','dfmodel'].includes(id));
const ledger=process.env.ROTOM_QODER_PROBE_LEDGER;assert(ledger&&process.execArgv.some(x=>x.endsWith('live-budget.mjs'))&&process.execArgv.includes('--experimental-import-meta-resolve'));
const count=()=>Number(readFileSync(ledger,'utf8')),before=count(),hash=()=>createHash('sha256').update(readFileSync(process.env.ROTOM_QODER_PROBE_AUTH_FILE)).digest('hex'),original=hash();
const dir=realpathSync(mkdtempSync(join(dirname(ledger),'qoder-efforts-')));chmodSync(dir,0o700);
const summary={pass:false,model:id,adapter:product?'product provider':'research, not product',cases:[],directory:dir};const save=()=>writeFileSync(join(dir,'result.json'),JSON.stringify(summary,null,2),{mode:0o600});save();console.error('Evidence: '+dir);
const entryURL=pathToFileURL(process.env.ROTOM_PI).href,piAI=await import(import.meta.resolve('@earendil-works/pi-ai',entryURL)),openAI=await import(import.meta.resolve('@earendil-works/pi-ai/api/openai-completions',entryURL)),sdk=await import(import.meta.resolve('@earendil-works/pi-coding-agent',entryURL));
try{
 const credential=await readProbeCredential(),r=await fetch(CATALOG_URL,{headers:catalogHeaders(credential),redirect:'error',signal:AbortSignal.timeout(15000)});assert(r.ok);let n=0;const chunks=[];for await(const b of r.body){n+=b.length;assert(n<=512*1024);chunks.push(b);}const catalog=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 const e=catalog.assistant.find(x=>x.key===id&&x.source==='system'&&x.enable&&x.format==='openai');assert(e?.thinking_config?.enabled?.efforts);
 const entry={key:e.key,display_name:e.display_name,enable:true,source:'system',format:'openai',max_input_tokens:e.max_input_tokens,is_reasoning:e.is_reasoning===true,is_vl:e.is_vl===true};
 const levels=['low','medium','high','xhigh','max'].filter(k=>Object.hasOwn(e.thinking_config.enabled.efforts,k));if(e.thinking_config.disabled&&typeof e.thinking_config.disabled==='object')levels.unshift('off');assert(levels.length);
 summary.advertised=levels;
 let provider,auth,productModel,currentCase,currentLevel,expectedOpaque,expectedPlain,expectedToolId,expectedMarker;
 if(product){
  const root=process.env.ROTOM_QODER_PROBE_PRODUCT_ROOT??resolve(import.meta.dirname,'../../rotom');assert(isAbsolute(root)&&realpathSync(root)===root);
  summary.identity={productRoot:root,piEntry:process.env.ROTOM_PI,piEntrySha256:createHash('sha256').update(readFileSync(process.env.ROTOM_PI)).digest('hex'),sdkModule:import.meta.resolve('@earendil-works/pi-coding-agent',entryURL),qoderDigests:Object.fromEntries(['catalog.mjs','legacy.mjs','provider.mjs','transport.mjs'].map(f=>[f,createHash('sha256').update(readFileSync(join(root,'extensions/qoder',f))).digest('hex')]))};
  const {createQoderProvider}=await import(pathToFileURL(join(root,'extensions/qoder/provider.mjs')).href);
  provider=await createQoderProvider({piAI,openAI,authMode:'browser',onDiagnostic:d=>{if(currentCase&&['field_prefix_continuation','frame_continuation','usage_continuation','invalid_sse_json'].includes(d.code)){currentCase.diagnostics??={};currentCase.diagnostics[d.code]=(currentCase.diagnostics[d.code]??0)+1;}},fetchImpl:async(url,init)=>{
   if(url===CATALOG_URL)return Response.json(catalog); // Fresh same-account directory fetched once above.
   assert(currentCase&&currentLevel);assert.equal(url,LEGACY_MODEL_IDS.includes(id)?LEGACY_URL:MODEL.baseUrl+'/chat/completions');
   const body=url===LEGACY_URL?decodeProbeBody(init.body):JSON.parse(init.body),controls=url===LEGACY_URL?body.parameters:body;
   assert.equal(controls.reasoning_effort,currentLevel==='off'?'none':currentLevel);assert.equal(controls.enable_thinking,currentLevel!=='off');
   if(expectedToolId){
    assert(body.messages.some(m=>m.role==='tool'&&m.tool_call_id===expectedToolId&&m.content===expectedMarker));currentCase.toolWireReplay=true;
    if(expectedOpaque){assert(body.messages.some(m=>m.role==='assistant'&&JSON.stringify(m.reasoning_item)===JSON.stringify(expectedOpaque)));currentCase.opaqueWireReplay=true;}
    if(expectedPlain!==undefined){assert(body.messages.some(m=>m.role==='assistant'&&m.reasoning_content===expectedPlain));currentCase.plainWireReplay=true;}
   }
   const response=await fetch(url,init);currentCase.httpStatus=response.status;currentCase.wire.push({effort:controls.reasoning_effort,enableThinking:controls.enable_thinking,...await observeStream(response)});save();return response;
  }});
  await provider.refreshModels({credential:credential.oauthCredential,allowNetwork:true,signal:AbortSignal.timeout(20000),publish:async p=>{p.update?.();return true;}});
  auth=await provider.auth.oauth.toAuth(credential.oauthCredential);productModel=provider.getModels().find(m=>m.id===id);assert(productModel?.compat.supportsReasoningEffort);
  summary.productLevels=piAI.getSupportedThinkingLevels(productModel);
 }
 const selected=selection&&selection!=='all'?selection.split(','):product?summary.productLevels:levels;assert(selected.length&&new Set(selected).size===selected.length&&selected.every(l=>levels.includes(l)));
 for(const level of selected){
  const c={level,pass:false,rounds:[],wire:[]};summary.cases.push(c);const enabled=level!=='off',nonce=randomUUID(),marker='EFFORT_RESULT_'+randomUUID();
  currentCase=c;currentLevel=level;expectedOpaque=undefined;expectedPlain=undefined;expectedToolId=undefined;expectedMarker=undefined;
  const model=productModel??{...MODEL,id,reasoning:true,compat:{...MODEL.compat,supportsReasoningEffort:true},thinkingLevelMap:{off:'none',minimal:null,low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'}};
  const tool={name:'effort_probe',description:'Synthetic check with no external effects. Returns a fresh marker.',parameters:piAI.Type.Object({nonce:piAI.Type.String()},{additionalProperties:false})};
  const context={systemPrompt:'Synthetic reasoning protocol test. Use the requested tool then return its exact marker.',messages:[{role:'user',content:`Call effort_probe exactly once with nonce ${nonce}. After its result, reply with exactly the returned text. Do not answer before the tool result.`,timestamp:Date.now()}],tools:[tool]};
  try{
   for(let round=0;round<2;round++){
    const stream=product?provider.streamSimple(model,context,{...auth,...enabled?{reasoning:level}:{},maxTokens:4096,sessionId:nonce}):openAI.stream(model,context,{apiKey:'synthetic-resolved-at-transport',maxRetries:0,maxTokens:4096,...enabled?{reasoningEffort:level}:{},fetch:async(_url,init)=>{
     const p=JSON.parse(init.body);assert.equal(p.reasoning_effort,enabled?level:'none');
     const messages=p.messages.map(m=>{if(m.reasoning_details==null)return m;const {reasoning_details,...rest}=m;return{...rest,reasoning_item:reasoningDetailsToItem(reasoning_details,id)};});
     const wire=probeWire({id,entry,credential,messages,tools:p.tools??[],effort:enabled?level:'none',contextLength:LEGACY_MODEL_IDS.includes(id)?32000:null,maxTokens:4096});
     const response=await fetch(wire.url,{method:'POST',body:wire.body,headers:wire.headers,redirect:'error',signal:AbortSignal.timeout(90000)});c.httpStatus=response.status;assert(response.ok);
     c.wire.push({round,effort:enabled?level:'none',enableThinking:enabled,...await observeStream(response)});save();
     const frames=normalizeSSE(response.body,{toolNames:[tool.name],allowReasoning:enabled,allowOpaqueReasoning:OPAQUE_MODEL_IDS.includes(id),opaqueModelId:id,allowLegacyEnvelope:LEGACY_MODEL_IDS.includes(id),allowLegacyMetricsDone:['smodel','mmodel'].includes(id)});
     let terminal;return new Response(new ReadableStream({async pull(out){try{for(;;){const x=await frames.next();if(x.done){if(terminal)out.enqueue(new TextEncoder().encode(terminal));out.close();return;}if(x.value==='data: [DONE]\n\n'){terminal=x.value;continue;}out.enqueue(new TextEncoder().encode(x.value));return;}}catch(error){out.error(error);}},async cancel(){await frames.return();}}),{headers:{'content-type':'text/event-stream'}});
    }});
    for await(const _event of stream){}const result=await stream.result();c.rounds.push({stopReason:result.stopReason,reasoningObserved:result.content.some(b=>b.type==='thinking'),input:result.usage.input,output:result.usage.output,errorCode:result.errorMessage?.match(/Qoder: ([a-z0-9_]+)/)?.[1]});save();
    if(round===0){assert.equal(result.stopReason,'toolUse');const calls=result.content.filter(b=>b.type==='toolCall');assert.equal(calls.length,1);assert.equal(calls[0].name,tool.name);assert.deepEqual(calls[0].arguments,{nonce});
     const opaque=result.content.find(b=>b.type==='thinking'&&b.thinkingSignature?.startsWith('[')),plain=result.content.find(b=>b.type==='thinking'&&b.thinkingSignature==='reasoning_content');
     expectedOpaque=opaque?reasoningDetailsToItem(JSON.parse(opaque.thinkingSignature),id):undefined;expectedPlain=plain?.thinking;expectedToolId=calls[0].id;expectedMarker=marker;c.opaqueObserved=!!opaque;c.plainReasoningObserved=!!plain;
     context.messages.push(result,{role:'toolResult',toolCallId:calls[0].id,toolName:tool.name,content:[{type:'text',text:marker}],isError:false,timestamp:Date.now()});
     const manager=sdk.SessionManager.create(dir,dir);manager.appendModelChange(model.provider,id);for(const m of context.messages)manager.appendMessage(m);const restored=sdk.SessionManager.open(manager.getSessionFile(),dir).buildSessionContext().messages;assert.equal(JSON.stringify(restored),JSON.stringify(context.messages));context.messages=restored;c.diskReplay=true;
    }else{assert.equal(result.stopReason,'stop');const text=result.content.filter(b=>b.type==='text').map(b=>b.text).join('').trim();c.answerBytes=Buffer.byteLength(text);c.answerExact=text===marker;assert.deepEqual([...new Set(text.match(/EFFORT_RESULT_[a-f0-9-]{36}/g)??[])],[marker]);c.markerExact=true;}
   }
   c.pass=true;
  }catch(error){c.errorCode=error.code==='ERR_ASSERTION'?'assertion_failed':/^[a-z0-9_]+$/.test(error.code??'')?error.code:'probe_failed';c.errorLine=error.stack?.match(/effort-probe\.mjs:(\d+):/)?.[1];}
  save();
 }
 summary.pass=summary.cases.every(c=>c.pass);
}catch(error){summary.errorCode=error.code==='ERR_ASSERTION'?'assertion_failed':/^[a-z0-9_]+$/.test(error.code??'')?error.code:'probe_failed';}
summary.requests=count()-before;summary.ledgerTotal=count();summary.credentialsUnchanged=hash()===original;assert(summary.credentialsUnchanged);save();const {cases,...out}=summary;console.log(JSON.stringify({...out,cases:cases.map(({wire,...c})=>c)},null,2));if(!summary.pass)process.exitCode=1;
