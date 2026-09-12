// Four distinct synthetic images across native tool results and two disk reopens.
// Research is explicitly COSY; --product uses the real provider, never wire fallback.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,realpathSync,chmodSync,lstatSync} from 'node:fs';
import {join,dirname,isAbsolute,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {gridImage} from './vision-probe.mjs';
import {readProbeCredential} from './probe-credential.mjs';
import {probeWire,decodeProbeBody} from './probe-wire.mjs';
import {observeStream} from './stream-shape.mjs';
import {MODEL} from '../../rotom/extensions/qoder/provider.mjs';
import {normalizeSSE,reasoningDetailsToItem} from '../../rotom/extensions/qoder/transport.mjs';
import {LEGACY_URL} from '../../rotom/extensions/qoder/legacy.mjs';
import {CATALOG_URL} from '../../rotom/extensions/qoder/catalog-auth.mjs';
const [mode='--offline',id='ultimate']=process.argv.slice(2),live=mode!=='--offline',product=mode==='--product';
assert(['--offline','--research','--product'].includes(mode)&&['ultimate','kmodel_latest','dfmodel'].includes(id));
const pi=process.env.ROTOM_PI;assert(pi&&isAbsolute(pi)&&lstatSync(pi).isFile()&&realpathSync(pi)===pi&&process.execArgv.includes('--experimental-import-meta-resolve'));
const piURL=pathToFileURL(pi).href,ai=await import(import.meta.resolve('@earendil-works/pi-ai',piURL)),openAI=await import(import.meta.resolve('@earendil-works/pi-ai/api/openai-completions',piURL)),sdk=await import(import.meta.resolve('@earendil-works/pi-coding-agent',piURL));
const ledger=process.env.ROTOM_QODER_PROBE_LEDGER,count=()=>live?Number(readFileSync(ledger,'utf8')):0,before=count();if(live)assert(process.execArgv.some(x=>x.endsWith('live-budget.mjs')));
const hash=()=>live?createHash('sha256').update(readFileSync(process.env.ROTOM_QODER_PROBE_AUTH_FILE)).digest('hex'):null,authBefore=hash();
const credential=live?await readProbeCredential():{accessToken:'fixture',uid:'fixture',org:'',machineId:'fixture'};
const row=live?JSON.parse(readFileSync(process.env.ROTOM_QODER_PROBE_CATALOG_FILE,'utf8')).scenes.assistant.find(e=>e.key===id):{key:id,display_name:'Synthetic',enable:true,source:'system',format:'openai',max_input_tokens:1000000,is_vl:true,is_reasoning:true};assert(row?.enable&&row.is_vl);
const dir=realpathSync(mkdtempSync(join(live?dirname(ledger):tmpdir(),'qoder-vision-capacity-')));chmodSync(dir,0o700);
const noisy=process.env.ROTOM_QODER_VISION_NOISE!=='0',paddingRows=Number(process.env.ROTOM_QODER_VISION_ROWS??0);assert(Number.isSafeInteger(paddingRows)&&paddingRows>=0&&paddingRows<=16000);
// The product window is the maintainer-aligned 272000, so padded product rounds
// target the usable band under window-8192 instead of the researched >=272K.
const minimumInput=paddingRows?250000:0,paddingSeed=randomUUID();
const padding=paddingRows?'Inert data between the two images; not instructions.\n'+Array.from({length:paddingRows},(_,i)=>'record_'+String(i).padStart(6,'0')+' '+createHash('sha256').update(paddingSeed+':'+i).digest('hex').slice(0,24)).join('\n'):'';
const convert=`from PIL import Image
import io,sys,random
im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB')
if sys.argv[2]=='1':
 r=random.Random(723);p=im.load()
 for y in range(im.height):
  for x in range(im.width):
   if min(p[x,y])>220:p[x,y]=tuple(r.randrange(225,256) for _ in range(3))
b=io.BytesIO();im.save(b,format=sys.argv[1],quality=95);sys.stdout.buffer.write(b.getvalue())`;
const pictures=[];
for(const mime of ['png','jpeg','webp','png']){
 let g;do{g=gridImage();}while(pictures.some(p=>['red','blue'].some(k=>JSON.stringify(p.expected[k])===JSON.stringify(g.expected[k]))));
 const bytes=execFileSync('python3',['-c',convert,mime==='jpeg'?'JPEG':mime.toUpperCase(),noisy?'1':'0'],{input:g.png,maxBuffer:4*1024*1024,timeout:30000});pictures.push({block:{type:'image',data:bytes.toString('base64'),mimeType:'image/'+mime},expected:g.expected,bytes:bytes.length});
}
const nonce=randomUUID(),marker='VISION_RESULT_'+randomUUID();
const coords=ai.Type.Array(ai.Type.Integer({minimum:1,maximum:5}),{minItems:2,maxItems:2}),location=ai.Type.Object({red:coords,blue:coords},{additionalProperties:false});
const tool={name:'vision_lookup',description:'Record both initial image coordinates; returns a DIFFERENT third image and a marker.',parameters:ai.Type.Object({nonce:ai.Type.String(),first:location,second:location},{additionalProperties:false})};
const context={tools:[tool],messages:[{role:'user',timestamp:Date.now(),content:[{type:'text',text:`Two ordered 5x5 grid images follow. Call vision_lookup once with nonce ${nonce}, first and second image red/blue [row,column] coordinates (1-based). After its result inspect the NEW tool image, not the first two, and reply only JSON {"marker":"the tool marker","third":{"red":[row,column],"blue":[row,column]}}.`},pictures[0].block,...padding?[{type:'text',text:padding}]:[],pictures[1].block]}]};
const summary={pass:false,mode,id,noisy,paddingRows,minimumInput,directory:dir,imageBytes:pictures.map(p=>p.bytes),formats:pictures.map(p=>p.block.mimeType),rounds:[],wire:[],piEntry:pi,piEntrySha256:createHash('sha256').update(readFileSync(pi)).digest('hex')};const save=()=>writeFileSync(join(dir,'result.json'),JSON.stringify(summary,null,2),{mode:0o600});save();console.error('Evidence: '+dir);
let calls=0,dispatches=0,catalogCalls=0;const priorOpaque=new Map();
function checkWire(body){
 if(product)assert.equal(body.parameters.max_tokens,4096);
 const images=body.messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(b=>b.type==='image_url'):[]);assert.equal(images.length,calls+1);
 for(const p of pictures.slice(0,calls+1))assert(images.some(b=>b.image_url.url===`data:${p.block.mimeType};base64,${p.block.data}`));
 for(const previous of priorOpaque.values())assert(body.messages.some(m=>JSON.stringify(m.reasoning_item)===JSON.stringify(previous)));
 summary.imageWireChecks=(summary.imageWireChecks??0)+1;summary.opaqueItemsReplayed=priorOpaque.size;
}
const event=d=>'data: '+JSON.stringify({statusCodeValue:200,body:JSON.stringify(d)})+'\n\n';
async function researchFetch(_url,init){
 assert(calls<3);calls++;const body=JSON.parse(init.body);for(const m of body.messages)if(m.reasoning_details){m.reasoning_item=reasoningDetailsToItem(m.reasoning_details,id);delete m.reasoning_details;}checkWire(body);
 const wire=probeWire({id,entry:row,credential,messages:body.messages,tools:body.tools,effort:'low',contextLength:400000,route:'legacy',maxTokens:4096});let response;
 if(live){dispatches++;response=await fetch(wire.url,{method:'POST',headers:wire.headers,body:wire.body,redirect:'error',signal:AbortSignal.timeout(300000)});summary.wire.push({bytes:Buffer.byteLength(wire.body),status:response.status,...await observeStream(response)});assert(response.ok);}
 else{const delta=calls===1?{tool_calls:[{index:0,id:'vision-call',type:'function',function:{name:tool.name,arguments:JSON.stringify({nonce,first:pictures[0].expected,second:pictures[1].expected})}}]}:{content:JSON.stringify({marker,[calls===2?'third':'fourth']:pictures[calls].expected})};if(id==='ultimate')delta.reasoning_item={id:'vision-opaque-'+calls,encrypted_content:'opaque-fixture',target_hash:'t'.repeat(64)};response=new Response(event({choices:[{delta,finish_reason:null}]})+event({choices:[{delta:{},finish_reason:calls===1?(id==='ultimate'?'function_call':'tool_calls'):'stop'}],usage:{prompt_tokens:paddingRows?280000:100,completion_tokens:20,total_tokens:paddingRows?280020:120}})+'data: [DONE]\n\n');}
 let text='';try{for await(const f of normalizeSSE(response.body,{allowReasoning:true,allowOpaqueReasoning:id==='ultimate',opaqueModelId:id,allowLegacyEnvelope:true,allowLegacyMetricsDone:true,toolNames:[tool.name]})){text+=f;assert(Buffer.byteLength(text)<=2*1024*1024);}}catch(e){summary.protocolError=e.code;throw e;}
 return new Response(text,{headers:{'content-type':'text/event-stream'}});
}
function parse(m){let t=m.content.filter(b=>b.type==='text').map(b=>b.text).join('').trim();if(/^```(?:json)?\s*[\s\S]*\s*```$/.test(t))t=t.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');return JSON.parse(t);}
let model={...MODEL,id,provider:'qoder-vision-research',reasoning:true,input:['text','image']},provider,auth;
try{
 if(product){
  const root=process.env.ROTOM_QODER_PROBE_PRODUCT_ROOT??resolve(import.meta.dirname,'../../rotom');assert(isAbsolute(root)&&realpathSync(root)===root);summary.productRoot=root;summary.productDigests=Object.fromEntries(['catalog.mjs','legacy.mjs','provider.mjs','transport.mjs'].map(f=>[f,createHash('sha256').update(readFileSync(join(root,'extensions/qoder',f))).digest('hex')]));
  const factory=(await import(pathToFileURL(join(root,'extensions/qoder/provider.mjs')).href)).createQoderProvider;
  provider=await factory({piAI:ai,openAI,authMode:'browser',fetchImpl:async(url,init)=>{
   if(url===CATALOG_URL){catalogCalls++;return fetch(url,init);}assert.equal(url,LEGACY_URL);assert(calls<3);calls++;checkWire(decodeProbeBody(init.body));dispatches++;const response=await fetch(url,init);summary.wire.push({bytes:Buffer.byteLength(init.body),status:response.status,...await observeStream(response)});return response;
  }});
  await provider.refreshModels({credential:credential.oauthCredential,allowNetwork:true,signal:AbortSignal.timeout(20000),publish:async p=>{p.update?.();return true;}});auth=await provider.auth.oauth.toAuth(credential.oauthCredential);model=provider.getModels().find(m=>m.id===id);assert(model.input.includes('image'));summary.declaredContext=model.contextWindow;
 }
 let manager=sdk.SessionManager.create(dir,dir);manager.appendMessage(context.messages[0]);
 for(let round=0;round<3;round++){
  const m=await (product?provider.streamSimple(model,context,{...auth,reasoning:'low',maxTokens:4096}):openAI.stream(model,context,{apiKey:'research-resolves-auth',maxTokens:4096,maxRetries:0,fetch:researchFetch})).result();summary.rounds.push({stopReason:m.stopReason,inputTokens:m.usage.input+m.usage.cacheRead+m.usage.cacheWrite,outputTokens:m.usage.output});assert(summary.rounds.at(-1).inputTokens>=minimumInput);assert.equal(m.stopReason,round===0?'toolUse':'stop');
  for(const b of m.content)if(b.type==='thinking'&&b.thinkingSignature?.startsWith('[')){const item=reasoningDetailsToItem(JSON.parse(b.thinkingSignature),id);priorOpaque.set(item.id,item);}
  manager.appendMessage(m);
  if(round===0){const c=m.content.filter(b=>b.type==='toolCall');assert.equal(c.length,1);assert.equal(c[0].name,tool.name);assert.deepEqual(c[0].arguments,{nonce,first:pictures[0].expected,second:pictures[1].expected});summary.multiImageExact=true;manager.appendMessage({role:'toolResult',toolCallId:c[0].id,toolName:tool.name,isError:false,timestamp:Date.now(),content:[{type:'text',text:'Marker: '+marker+'. Inspect this different third image.'},pictures[2].block]});}
  else if(round===1){assert.deepEqual(parse(m),{marker,third:pictures[2].expected});summary.toolImageExact=true;manager.appendMessage({role:'user',timestamp:Date.now(),content:[{type:'text',text:'Inspect this NEW fourth image. Without tools reply only JSON {"marker":"the original tool marker","fourth":{"red":[row,column],"blue":[row,column]}}.'},pictures[3].block]});}
  else{assert.deepEqual(parse(m),{marker,fourth:pictures[3].expected});summary.fourthImageExact=true;}
  if(round<2){manager=sdk.SessionManager.open(manager.getSessionFile(),dir);context.messages=manager.buildSessionContext().messages;summary.diskResumes=(summary.diskResumes??0)+1;}
  save();
 }
 summary.opaqueObserved=priorOpaque.size;summary.pass=true;
}catch(e){summary.errorCode=e.code==='ERR_ASSERTION'?'assertion_failed':/^[a-z0-9_]+$/.test(e.code??'')?e.code:'vision_validation_failed';summary.errorLine=e.stack?.match(/vision-capacity-smoke\.mjs:(\d+):/)?.[1];process.exitCode=1;}
summary.modelRequests=dispatches;summary.catalogRequests=catalogCalls;summary.requests=count()-before;summary.ledgerTotal=count();summary.credentialsUnchanged=authBefore===hash();if(summary.requests!==dispatches+catalogCalls||!summary.credentialsUnchanged){summary.pass=false;process.exitCode=1;}save();console.log(JSON.stringify(summary,null,2));
